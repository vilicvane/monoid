import {CHAIN_ID, type GasSample, summarizeHistory} from './history.js';

export async function serveHistory(
  request: Request,
  loadSamples: () => Promise<GasSample[]>,
): Promise<Response> {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Cache-Control': 'no-store',
  };
  if (new URL(request.url).pathname !== `/api/gas-history/${CHAIN_ID}`) {
    return new Response('Not found', {status: 404, headers});
  }
  if (request.method === 'OPTIONS')
    return new Response(null, {status: 204, headers});
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', {status: 405, headers});
  }
  try {
    const body = summarizeHistory(
      await loadSamples(),
      Math.floor(Date.now() / 1000),
    );
    return new Response(
      request.method === 'HEAD' ? null : JSON.stringify(body),
      {
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
        },
      },
    );
  } catch {
    return new Response('Gas history unavailable', {status: 503, headers});
  }
}
