#!/usr/bin/env node
// Experimental Wi-Fi receiver for cameras with a "View on TV" mode (e.g. the
// Sony RX100 II). It announces this Mac as a DLNA/UPnP MediaRenderer; when the
// camera "plays" a photo to it, the camera hands over a URL on its own HTTP
// server, and this script downloads that file into the import folder.
// Everything the camera sends is logged, since the exact behaviour per camera
// model is not documented.
import http from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const IMPORT_DIR = process.env.SDPV_IMPORT_DIR || path.join(os.homedir(), 'Pictures', 'RX100');
const HTTP_PORT = Number(process.env.RECEIVER_PORT) || 49152;
const SSDP_PORT = Number(process.env.SSDP_PORT) || 1900;
const SSDP_ADDR = '239.255.255.250';
const FRIENDLY_NAME = process.env.RECEIVER_NAME || `${os.hostname().split('.')[0]} Photo Receiver`;
// A stable id, so the camera sees the same device on every run.
const idHex = crypto.createHash('sha1').update(`sdpv-receiver:${os.hostname()}`).digest('hex');
const UUID = [idHex.slice(0, 8), idHex.slice(8, 12), idHex.slice(12, 16), idHex.slice(16, 20), idHex.slice(20, 32)].join('-');

function localIp() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}
const IP = process.env.RECEIVER_IP || localIp();
const BASE = `http://${IP}:${HTTP_PORT}`;

const SVC = {
  AVTransport: 'urn:schemas-upnp-org:service:AVTransport:1',
  RenderingControl: 'urn:schemas-upnp-org:service:RenderingControl:1',
  ConnectionManager: 'urn:schemas-upnp-org:service:ConnectionManager:1'
};
const DEVICE_TYPE = 'urn:schemas-upnp-org:device:MediaRenderer:1';

// Action definitions: inputs, and outputs with the value to answer with.
const ACTIONS = {
  AVTransport: {
    SetAVTransportURI: { in: ['InstanceID', 'CurrentURI', 'CurrentURIMetaData'], out: {} },
    SetNextAVTransportURI: { in: ['InstanceID', 'NextURI', 'NextURIMetaData'], out: {} },
    Play: { in: ['InstanceID', 'Speed'], out: {} },
    Stop: { in: ['InstanceID'], out: {} },
    Pause: { in: ['InstanceID'], out: {} },
    GetTransportInfo: {
      in: ['InstanceID'],
      out: { CurrentTransportState: 'STOPPED', CurrentTransportStatus: 'OK', CurrentSpeed: '1' }
    },
    GetMediaInfo: {
      in: ['InstanceID'],
      out: {
        NrTracks: '1', MediaDuration: '00:00:00', CurrentURI: '', CurrentURIMetaData: '',
        NextURI: '', NextURIMetaData: '', PlayMedium: 'NETWORK', RecordMedium: 'NOT_IMPLEMENTED',
        WriteStatus: 'NOT_IMPLEMENTED'
      }
    },
    GetPositionInfo: {
      in: ['InstanceID'],
      out: {
        Track: '1', TrackDuration: '00:00:00', TrackMetaData: '', TrackURI: '',
        RelTime: '00:00:00', AbsTime: '00:00:00', RelCount: '0', AbsCount: '0'
      }
    }
  },
  RenderingControl: {
    GetVolume: { in: ['InstanceID', 'Channel'], out: { CurrentVolume: '0' } },
    SetVolume: { in: ['InstanceID', 'Channel', 'DesiredVolume'], out: {} },
    GetMute: { in: ['InstanceID', 'Channel'], out: { CurrentMute: '0' } },
    SetMute: { in: ['InstanceID', 'Channel', 'DesiredMute'], out: {} }
  },
  ConnectionManager: {
    GetProtocolInfo: {
      in: [],
      out: {
        Source: '',
        Sink: [
          'http-get:*:image/jpeg:DLNA.ORG_PN=JPEG_SM',
          'http-get:*:image/jpeg:DLNA.ORG_PN=JPEG_MED',
          'http-get:*:image/jpeg:DLNA.ORG_PN=JPEG_LRG',
          'http-get:*:image/jpeg:*',
          'http-get:*:image/png:*',
          'http-get:*:image/gif:*'
        ].join(',')
      }
    },
    GetCurrentConnectionIDs: { in: [], out: { ConnectionIDs: '0' } },
    GetCurrentConnectionInfo: {
      in: ['ConnectionID'],
      out: {
        RcsID: '0', AVTransportID: '0', ProtocolInfo: '', PeerConnectionManager: '',
        PeerConnectionID: '-1', Direction: 'Input', Status: 'OK'
      }
    }
  }
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function log(...args) {
  console.log(new Date().toLocaleTimeString(), ...args);
}

function deviceXml() {
  const services = Object.entries(SVC).map(([name, type]) => `
      <service>
        <serviceType>${type}</serviceType>
        <serviceId>urn:upnp-org:serviceId:${name}</serviceId>
        <SCPDURL>/${name}.xml</SCPDURL>
        <controlURL>/ctl/${name}</controlURL>
        <eventSubURL>/evt/${name}</eventSubURL>
      </service>`).join('');
  return `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:dlna="urn:schemas-dlna-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <dlna:X_DLNADOC>DMR-1.50</dlna:X_DLNADOC>
    <dlna:X_DLNADOC>M-DMR-1.50</dlna:X_DLNADOC>
    <deviceType>${DEVICE_TYPE}</deviceType>
    <friendlyName>${esc(FRIENDLY_NAME)}</friendlyName>
    <manufacturer>sd-photo-viewer</manufacturer>
    <modelName>Photo Receiver</modelName>
    <UDN>uuid:${UUID}</UDN>
    <serviceList>${services}
    </serviceList>
  </device>
</root>`;
}

function scpdXml(name) {
  const actions = ACTIONS[name];
  const vars = new Set();
  const actionXml = Object.entries(actions).map(([action, def]) => {
    const args = [
      ...def.in.map((a) => ({ a, dir: 'in' })),
      ...Object.keys(def.out).map((a) => ({ a, dir: 'out' }))
    ].map(({ a, dir }) => {
      vars.add(`A_ARG_TYPE_${a}`);
      return `<argument><name>${a}</name><direction>${dir}</direction><relatedStateVariable>A_ARG_TYPE_${a}</relatedStateVariable></argument>`;
    }).join('');
    return `<action><name>${action}</name><argumentList>${args}</argumentList></action>`;
  }).join('');
  const varXml = [...vars].map((v) => `<stateVariable sendEvents="no"><name>${v}</name><dataType>string</dataType></stateVariable>`).join('');
  return `<?xml version="1.0"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>${actionXml}</actionList>
  <serviceStateTable>${varXml}</serviceStateTable>
</scpd>`;
}

function soapResponse(serviceType, action, out) {
  const body = Object.entries(out).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('');
  return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action}Response xmlns:u="${serviceType}">${body}</u:${action}Response></s:Body></s:Envelope>`;
}

function soapFault(code, description) {
  return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${description}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`;
}

// --- downloading what the camera offers ---------------------------------

const EXT_BY_TYPE = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif' };
const seenHashes = new Set();
let receivedCount = 0;

function bestUrlFromMetadata(currentUri, metadata) {
  // The camera's DIDL metadata may list several <res> entries (different
  // sizes) for one photo; prefer the one with the most pixels.
  const candidates = [];
  const re = /<res([^>]*)>([^<]*)<\/res>/g;
  let m;
  while ((m = re.exec(metadata))) {
    const res = /resolution="(\d+)x(\d+)"/.exec(m[1]);
    const size = /size="(\d+)"/.exec(m[1]);
    candidates.push({
      url: unesc(m[2]).trim(),
      pixels: res ? Number(res[1]) * Number(res[2]) : 0,
      size: size ? Number(size[1]) : 0
    });
  }
  if (candidates.length > 0) log('  res entries:', JSON.stringify(candidates));
  candidates.sort((a, b) => b.pixels - a.pixels || b.size - a.size);
  return candidates[0]?.url || currentUri;
}

function download(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), type: res.headers['content-type'] || '' }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchPhoto(url) {
  try {
    log('  downloading', url);
    const { buffer, type } = await download(url);
    const hash = crypto.createHash('sha1').update(buffer).digest('hex');
    if (seenHashes.has(hash)) {
      log('  already received this photo, skipping');
      return;
    }
    seenHashes.add(hash);
    const urlName = path.basename(new URL(url).pathname);
    const ext = path.extname(urlName) || EXT_BY_TYPE[type.split(';')[0]] || '.jpg';
    const day = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dayDir = path.join(IMPORT_DIR, `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`);
    await fs.mkdir(dayDir, { recursive: true });
    const base = path.basename(urlName, path.extname(urlName)) || `wifi-${Date.now()}`;
    let target = path.join(dayDir, `${base}${ext}`);
    for (let n = 1; await fs.access(target).then(() => true, () => false); n++) {
      target = path.join(dayDir, `${base}_${n}${ext}`);
    }
    await fs.writeFile(target, buffer);
    receivedCount++;
    log(`  saved ${target} (${buffer.length} bytes, ${type || 'unknown type'})`);
  } catch (err) {
    log('  download failed:', String(err));
  }
}

// --- HTTP: device description, SOAP control, event subscriptions ---------

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    log(`${req.method} ${req.url} from ${req.socket.remoteAddress}`);
    if (body) log('  body:', body.length > 2000 ? `${body.slice(0, 2000)}...` : body);

    if (req.method === 'GET' && req.url === '/') {
      return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
        `<!doctype html><meta charset="utf-8"><title>Photo Receiver</title>` +
        `<body style="font:16px system-ui;max-width:36rem;margin:3rem auto;padding:0 1rem">` +
        `<h1>${esc(FRIENDLY_NAME)}</h1>` +
        `<p>Running. On the camera, use Menu &gt; Wireless &gt; View on TV and pick this Mac.</p>` +
        `<p>Photos received so far this session: <b>${receivedCount}</b><br>Saved to: <code>${esc(IMPORT_DIR)}</code></p>` +
        `<p>To browse them, run <code>sd-photo-viewer</code>, open <a href="http://localhost:4173">localhost:4173</a> and load that folder.</p>`
      );
    }
    if (req.method === 'GET' && req.url === '/desc.xml') {
      return res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"' }).end(deviceXml());
    }
    const scpd = /^\/(\w+)\.xml$/.exec(req.url);
    if (req.method === 'GET' && scpd && ACTIONS[scpd[1]]) {
      return res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"' }).end(scpdXml(scpd[1]));
    }
    if (req.method === 'SUBSCRIBE') {
      return res.writeHead(200, {
        SID: `uuid:${crypto.randomUUID()}`,
        TIMEOUT: 'Second-300',
        'Content-Length': '0'
      }).end();
    }
    if (req.method === 'UNSUBSCRIBE') return res.writeHead(200).end();

    const ctl = /^\/ctl\/(\w+)$/.exec(req.url);
    if (req.method === 'POST' && ctl && ACTIONS[ctl[1]]) {
      const header = String(req.headers.soapaction || '').replace(/"/g, '');
      const action = header.split('#')[1];
      const def = ACTIONS[ctl[1]][action];
      if (!def) {
        log(`  unknown action ${header}`);
        return res.writeHead(500, { 'Content-Type': 'text/xml; charset="utf-8"' }).end(soapFault(401, 'Invalid Action'));
      }
      log(`  action ${ctl[1]}.${action}`);
      if (action === 'SetAVTransportURI') {
        const uri = /<CurrentURI[^>]*>([\s\S]*?)<\/CurrentURI>/.exec(body);
        const meta = /<CurrentURIMetaData[^>]*>([\s\S]*?)<\/CurrentURIMetaData>/.exec(body);
        const current = uri ? unesc(uri[1]).trim() : '';
        if (meta) log('  metadata:', unesc(meta[1]));
        const url = bestUrlFromMetadata(current, meta ? unesc(meta[1]) : '');
        if (url) fetchPhoto(url);
        else log('  no URL in SetAVTransportURI');
      }
      return res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"' })
        .end(soapResponse(SVC[ctl[1]], action, def.out));
    }

    log('  (unhandled)');
    res.writeHead(404).end();
  });
});

server.on('error', (err) => {
  console.error(`HTTP server error: ${err.message}`);
  process.exit(1);
});

// --- SSDP: tell the camera we exist --------------------------------------

const NOTIFY_TARGETS = [
  { nt: 'upnp:rootdevice', usn: `uuid:${UUID}::upnp:rootdevice` },
  { nt: `uuid:${UUID}`, usn: `uuid:${UUID}` },
  { nt: DEVICE_TYPE, usn: `uuid:${UUID}::${DEVICE_TYPE}` },
  ...Object.values(SVC).map((t) => ({ nt: t, usn: `uuid:${UUID}::${t}` }))
];
const SERVER_HEADER = `${os.type()}/${os.release()} UPnP/1.0 sd-photo-viewer/1.0`;

const ssdp = dgram.createSocket({ type: 'udp4', reuseAddr: true });

function send(message, port, address) {
  ssdp.send(Buffer.from(message), port, address, (err) => {
    if (err) log('  ssdp send error:', String(err));
  });
}

function announce(subType) {
  for (const { nt, usn } of NOTIFY_TARGETS) {
    const lines = [
      'NOTIFY * HTTP/1.1',
      `HOST: ${SSDP_ADDR}:1900`,
      `NT: ${nt}`,
      `NTS: ssdp:${subType}`,
      `USN: ${usn}`
    ];
    if (subType === 'alive') {
      lines.push('CACHE-CONTROL: max-age=1800', `LOCATION: ${BASE}/desc.xml`, `SERVER: ${SERVER_HEADER}`);
    }
    send(`${lines.join('\r\n')}\r\n\r\n`, 1900, SSDP_ADDR);
  }
}

ssdp.on('message', (msg, rinfo) => {
  const text = msg.toString('utf8');
  if (!text.startsWith('M-SEARCH')) return;
  const st = /^ST:\s*(.+)$/im.exec(text)?.[1].trim();
  log(`M-SEARCH for ${st} from ${rinfo.address}`);
  const matches = NOTIFY_TARGETS.filter(({ nt }) => st === 'ssdp:all' || st === nt);
  for (const { nt, usn } of matches) {
    send([
      'HTTP/1.1 200 OK',
      'CACHE-CONTROL: max-age=1800',
      'EXT:',
      `LOCATION: ${BASE}/desc.xml`,
      `SERVER: ${SERVER_HEADER}`,
      `ST: ${nt}`,
      `USN: ${usn}`
    ].join('\r\n') + '\r\n\r\n', rinfo.port, rinfo.address);
  }
});

ssdp.on('error', (err) => {
  console.error(`SSDP error: ${err.message}`);
  process.exit(1);
});

let timer;
function shutdown() {
  clearInterval(timer);
  announce('byebye');
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(HTTP_PORT, '0.0.0.0', () => {
  ssdp.bind(SSDP_PORT, () => {
    try {
      ssdp.addMembership(SSDP_ADDR, IP);
    } catch (err) {
      log('could not join multicast group (is Wi-Fi up?):', String(err));
    }
    announce('alive');
    timer = setInterval(() => announce('alive'), 30000);
    log(`"${FRIENDLY_NAME}" ready at ${BASE}/desc.xml`);
    log(`Saving to ${IMPORT_DIR}`);
    log('On the camera: Menu > Wireless > View on TV, and pick this Mac. Ctrl+C to stop.');
  });
});
