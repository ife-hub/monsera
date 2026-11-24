/**
 * The few pieces of `next/server` the route handlers use, on top of the
 * standard Fetch API. Handlers were written for Next.js route handlers; this
 * lets them run unchanged behind the Express adapter in route-adapter.ts.
 */
export class NextRequest extends Request {
  get nextUrl(): URL {
    return new URL(this.url);
  }
}

export class NextResponse extends Response {
  static json(body: unknown, init: ResponseInit = {}): NextResponse {
    const headers = new Headers(init.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new NextResponse(JSON.stringify(body), { ...init, headers });
  }
}
