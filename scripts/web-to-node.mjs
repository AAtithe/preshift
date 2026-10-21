// Runs a function written with Web handlers (export async function POST(request)) as a
// Node (req, res) handler, which is what Build Output API functions are invoked with.
export function toNodeHandler(mod) {
  return async (req, res) => {
    const handle = mod[req.method ?? 'GET'];
    if (typeof handle !== 'function') {
      res.writeHead(405, { allow: Object.keys(mod).join(', ') });
      return res.end();
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(new URL(req.url ?? '/', `https://${req.headers.host ?? 'localhost'}`), {
      method: req.method,
      headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });
    let response;
    try {
      response = await handle(request);
    } catch (err) {
      // Logged and answered, so a fault shows in the function logs instead of taking the function down.
      console.error(err);
      response = Response.json({ error: 'internal', message: 'Something went wrong' }, { status: 500 });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  };
}
