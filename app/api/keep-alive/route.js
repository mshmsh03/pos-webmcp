// ----------------------------------------------------------------------------
// Keeps the Supabase project from being paused.
//
// A free-tier Supabase project is paused after roughly a week of low activity,
// and — the part that bites — a paused project does NOT wake up when someone
// finally visits. It has to be resumed by hand from the dashboard. For a demo
// that has to stay reachable for judges long after it was last touched, that is
// the difference between a slow first load and an outage nobody is watching for.
//
// Supabase's own guidance is that "a few user requests to the database each day"
// is enough to prevent it, so this endpoint makes one, and vercel.json calls it
// on a daily schedule.
//
// It must be a *database* request. Pinging the site itself does nothing: every
// page here is client-rendered, so fetching the HTML never touches Postgres from
// the server side. Hence a real query, from the server, on a timer.
//
// The query returns no rows — Row Level Security only exposes the catalogue to
// signed-in users, and this request has no session — but it is still a query
// that reaches the database, which is exactly what's being asked for.
// ----------------------------------------------------------------------------

import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  // Vercel sends `Authorization: Bearer $CRON_SECRET` on scheduled invocations
  // when that environment variable is set. If it is set, require it: otherwise
  // this is an open endpoint that anyone can hold down to generate unbounded
  // database queries billed to the project. If it isn't set, the route still
  // works, so the cron keeps the database awake on a fresh deploy with no
  // extra setup — but the header is the intended configuration.
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: 'Not authorized.' }, { status: 401 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    return Response.json(
      { ok: false, error: 'Supabase environment variables are not set.' },
      { status: 500 }
    );
  }

  const started = Date.now();
  try {
    const supabase = createClient(url, key);
    // head:true asks for the count only, so nothing is transferred back.
    const { error } = await supabase
      .from('products')
      .select('id', { count: 'exact', head: true });

    // Row Level Security only exposes the catalogue to signed-in users and
    // this request carries no session, so the count comes back as 0 with no
    // error — which is fine. The request still reached Postgres, and that is
    // the entire job. Only a real transport or auth failure means it didn't.
    if (error) throw new Error(error.message);

    return Response.json({
      ok: true,
      reachedDatabase: true,
      ms: Date.now() - started,
      at: new Date().toISOString(),
    });
  } catch (err) {
    // Logged, not returned. This is a public URL; echoing the raw PostgREST or
    // network error back to the caller hands a stranger detail about the
    // database for no benefit to the cron job, which only reads the status.
    console.error('keep-alive failed:', err?.message ?? err);
    return Response.json(
      { ok: false, reachedDatabase: false, error: 'Could not reach the database.' },
      { status: 503 }
    );
  }
}
