import { createServer } from 'node:http';

const port = Number(process.env.PORT) || 3000;

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', path: req.url }));
});

server.listen(port, () => {
  console.log(`review-blaster listening on http://localhost:${port}`);
});
