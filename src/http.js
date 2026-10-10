import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

export async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'That request is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req) {
  const buf = await readBody(req, 256 * 1024);
  if (!buf.length) return {};
  try {
    const data = JSON.parse(buf.toString('utf8'));
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}

/** Minimal multipart/form-data parser (fields + files held in memory). */
export function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) throw new HttpError(400, 'Expected a multipart upload.');
  const boundary = Buffer.from('--' + (match[1] || match[2]));
  const fields = {};
  const files = [];

  let pos = buffer.indexOf(boundary);
  while (pos !== -1) {
    const next = buffer.indexOf(boundary, pos + boundary.length);
    if (next === -1) break;
    // part = between boundary + CRLF and CRLF before next boundary
    const part = buffer.subarray(pos + boundary.length + 2, next - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      const data = part.subarray(headerEnd + 4);
      const name = /name="([^"]*)"/i.exec(headers)?.[1];
      const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
      if (name !== undefined) {
        if (filename !== undefined) {
          files.push({ name, filename, data, contentType: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1] || '' });
        } else {
          fields[name] = data.toString('utf8');
        }
      }
    }
    pos = next;
  }
  return { fields, files };
}

export function parseCookies(header = '') {
  const out = {};
  for (const pair of header.split(';')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8'
};

export function serveStatic(req, res, root, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    rel = '/';
  }
  if (rel.includes('\0')) rel = '/';
  if (rel.endsWith('/')) rel += 'index.html';
  else if (!path.extname(rel)) rel += '.html';

  const file = path.join(root, path.normalize(rel));
  if (!file.startsWith(root + path.sep)) return notFound(res);

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return notFound(res);
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

export function notFound(res) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page not found · JobConnect</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/styles.css"></head>
<body class="notfound"><main><h1>404</h1><p>We couldn't find that page.</p><a class="btn btn-primary" href="/">Back to JobConnect</a></main></body></html>`;
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
