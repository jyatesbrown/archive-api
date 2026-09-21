/** RFC 9457 problem details. */

export const PROBLEM_TYPE_BASE = 'https://archive-api.dev/problems/';
/** Internal header so the request log can name the problem without re-reading the body. */
export const PROBLEM_CODE_HEADER = 'x-problem-code';

export type ProblemCode =
  | 'invalid_parameter'
  | 'missing_parameter'
  | 'unknown_source'
  | 'not_found'
  | 'method_not_allowed'
  | 'no_capture'
  | 'invalid_cursor'
  | 'internal';

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: ProblemCode;
  [ext: string]: unknown;
}

const TITLES: Record<ProblemCode, string> = {
  invalid_parameter: 'Invalid parameter',
  missing_parameter: 'Missing parameter',
  unknown_source: 'Unknown source',
  not_found: 'Not found',
  method_not_allowed: 'Method not allowed',
  no_capture: 'No capture on the requested date',
  invalid_cursor: 'Invalid cursor',
  internal: 'Internal error',
};

export function problem(
  code: ProblemCode,
  status: number,
  detail: string,
  instance: string,
  extensions: Record<string, unknown> = {},
): Response {
  const body: Problem = {
    type: PROBLEM_TYPE_BASE + code,
    title: TITLES[code],
    status,
    detail,
    instance,
    code,
    ...extensions,
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/problem+json; charset=utf-8',
      'cache-control': 'no-store',
      [PROBLEM_CODE_HEADER]: code,
    },
  });
}
