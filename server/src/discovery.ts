/** Versioned, bounded discovery. Never return memberships the caller cannot see. */
import { AuthContext, DbClient, HttpError, Row } from './types.js';

function options(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get('limit') ?? '50';
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 100)
    throw new HttpError(400, 'bad_request', 'limit must be 1-100');
  const after = url.searchParams.get('cursor') ?? '';
  if (after.length > 128) throw new HttpError(400, 'bad_request', 'Invalid cursor');
  const q = url.searchParams.get('q')?.trim() ?? '';
  if (q.length > 120)
    throw new HttpError(400, 'bad_request', 'Search must be at most 120 characters');
  const circle = url.searchParams.get('circle_id') ?? null;
  return { limit: Number(raw), after, q, circle, url };
}
function response(req: Request, key: string, rows: Row[], limit: number, id: string): Response {
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  return Response.json({
    protocol_version: 1,
    server: { url: new URL(req.url).origin },
    data: { [key]: items },
    page: { limit, next_cursor: more ? items[items.length - 1]?.[id] : null },
    request_id: req.headers.get('X-Request-ID'),
  });
}

export async function discoverCircles(
  db: DbClient,
  req: Request,
  auth: AuthContext,
): Promise<Response> {
  const { limit, after } = options(req);
  const rows = await db.queryAll(
    `SELECT f.id AS circle_id,f.name,f.kind,m.id AS member_id,m.role,m.principal_id AS user_id
    FROM families f JOIN members m ON m.family_id=f.id
    WHERE m.principal_id=? AND m.removed_at IS NULL AND f.id>? ORDER BY f.id LIMIT ?`,
    [auth.principal_id, after, limit + 1],
  );
  return response(req, 'circles', rows, limit, 'circle_id');
}

export async function discoverPeople(
  db: DbClient,
  req: Request,
  auth: AuthContext,
): Promise<Response> {
  const { limit, after, q, circle } = options(req);
  if (
    circle &&
    !(await db.queryOne(
      'SELECT id FROM members WHERE principal_id=? AND family_id=? AND removed_at IS NULL',
      [auth.principal_id, circle],
    ))
  ) {
    throw new HttpError(403, 'not_a_member', 'Not a member of the requested circle');
  }
  // instr treats '%' and '_' literally, avoiding accidental wildcard searches.
  const rows = await db.queryAll(
    `SELECT u.id AS user_id,u.name,u.email FROM principals u
    WHERE u.id>? AND (?='' OR instr(lower(u.name),lower(?))>0 OR instr(u.email,lower(?))>0)
    AND EXISTS(SELECT 1 FROM members target JOIN members own ON own.family_id=target.family_id
      WHERE target.principal_id=u.id AND target.removed_at IS NULL AND own.principal_id=? AND own.removed_at IS NULL
      AND (? IS NULL OR target.family_id=?)) ORDER BY u.id LIMIT ?`,
    [after, q, q, q, auth.principal_id, circle, circle, limit + 1],
  );
  const visible = rows.slice(0, limit);
  if (visible.length) {
    // Fixed-size bindings: D1 permits at most 100 SQL parameters. An IN
    // list of 100 users plus authorization parameters would exceed that.
    const lastId = visible[visible.length - 1]!['user_id'] as string;
    const memberships = await db.queryAll(
      `SELECT target.principal_id AS user_id,target.id AS member_id,target.family_id AS circle_id,
      f.name AS circle_name,target.role FROM members target JOIN families f ON f.id=target.family_id
      JOIN principals u ON u.id=target.principal_id
      WHERE u.id>? AND u.id<=? AND target.removed_at IS NULL
      AND (?='' OR instr(lower(u.name),lower(?))>0 OR instr(u.email,lower(?))>0)
      AND EXISTS(SELECT 1 FROM members own WHERE own.family_id=target.family_id AND own.principal_id=? AND own.removed_at IS NULL)
      AND (? IS NULL OR target.family_id=?) ORDER BY target.family_id`,
      [after, lastId, q, q, q, auth.principal_id, circle, circle],
    );
    for (const user of visible)
      user['memberships'] = memberships.filter((m) => m['user_id'] === user['user_id']);
  }
  return response(req, 'people', rows, limit, 'user_id');
}
