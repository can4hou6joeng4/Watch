#!/usr/bin/env node
import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.env.PORT || 4173);
const host = '127.0.0.1';
const siteDir = await realpath(path.resolve(process.cwd(), 'site'));

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8'
};

function isInSite(file) {
  const relative = path.relative(siteDir, file);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function sendError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
  } catch {
    return sendError(res, 400, '400 Bad Request');
  }
  if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0')) {
    return sendError(res, 400, '400 Bad Request');
  }

  const requested = path.resolve(siteDir, `.${pathname}`);
  if (!isInSite(requested)) return sendError(res, 404, '404 Not Found');

  try {
    const resolved = await realpath(requested);
    if (!isInSite(resolved)) return sendError(res, 404, '404 Not Found');
    const entry = await stat(resolved);
    // 生成的语言首页和指南保存为各自目录下的 index.html。
    const file = entry.isDirectory() ? await realpath(path.join(resolved, 'index.html')) : resolved;
    if (!isInSite(file) || !((file === resolved ? entry : await stat(file)).isFile())) {
      return sendError(res, 404, '404 Not Found');
    }

    const body = await readFile(file);
    const contentType = mimeTypes[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(body);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return sendError(res, 404, '404 Not Found');
    sendError(res, 500, '500 Internal Server Error');
  }
});

server.listen(port, host, () => {
  console.log(`\n🌐 AgentRelay 站点本地预览服务已启动`);
  console.log(`👉 http://${host}:${server.address().port}\n`);
});
