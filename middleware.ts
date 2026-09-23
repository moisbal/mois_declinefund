import { NextRequest, NextResponse } from 'next/server';
import { isPublicDemoMode, PUBLIC_DEMO_DISABLED_MESSAGE } from './lib/demo-mode';

function demoDestination(pathname: string) {
  if (pathname === '/analytics' || pathname.startsWith('/analytics/')) {
    return '/demo/analytics';
  }
  return '/demo';
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (!isPublicDemoMode) {
    const response = NextResponse.next();
    if (pathname.startsWith('/api/')) {
      response.headers.set('Cache-Control', 'private, no-store, no-cache, max-age=0, must-revalidate');
      response.headers.set('Pragma', 'no-cache');
      response.headers.set('Expires', '0');
    }
    return response;
  }
  if (pathname === '/demo' || pathname.startsWith('/demo/')) {
    return NextResponse.next();
  }

  // API routes and Server Actions must not silently redirect: callers receive a
  // clear denial, and no real-data endpoint is reached in a public demo build.
  if (pathname.startsWith('/api/') || !['GET', 'HEAD'].includes(request.method)) {
    return NextResponse.json({ message: PUBLIC_DEMO_DISABLED_MESSAGE }, { status: 403 });
  }

  return NextResponse.redirect(new URL(demoDestination(pathname), request.url));
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'],
};
