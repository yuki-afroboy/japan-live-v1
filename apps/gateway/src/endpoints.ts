/**
 * The complete set of upstreams this gateway will talk to.
 *
 * A client names a route key; it never supplies a URL. Anything not in this table is a
 * 404, so the gateway cannot be turned into an open proxy that would attach our
 * credential to an arbitrary destination.
 */
export interface EndpointSpec {
  /** Upstream URL, without the consumer key. */
  url: string;
  /** Query parameters to add, again without the key. */
  params: Record<string, string>;
  /** Seconds to cache. Never longer than the feed's real update interval. */
  cacheSeconds: number;
  /** Human label used in logs. Never includes credentials. */
  label: string;
}

const ODPT_V4 = "https://api.odpt.org/api/v4";

export const ENDPOINTS: Record<string, EndpointSpec> = {
  "/v1/toei/trains": {
    url: `${ODPT_V4}/odpt:Train`,
    params: { "odpt:operator": "odpt.Operator:Toei" },
    // The feed refreshes every 10-30 s; caching longer would hand clients stale data.
    cacheSeconds: 15,
    label: "toei.trains",
  },
  "/v1/toei/status": {
    url: `${ODPT_V4}/odpt:TrainInformation`,
    params: { "odpt:operator": "odpt.Operator:Toei" },
    cacheSeconds: 30,
    label: "toei.status",
  },
  "/v1/metro/trains": {
    url: `${ODPT_V4}/odpt:Train`,
    params: { "odpt:operator": "odpt.Operator:TokyoMetro" },
    cacheSeconds: 15,
    label: "metro.trains",
  },
  "/v1/metro/status": {
    url: `${ODPT_V4}/odpt:TrainInformation`,
    params: { "odpt:operator": "odpt.Operator:TokyoMetro" },
    cacheSeconds: 30,
    label: "metro.status",
  },
};

export function specFor(pathname: string): EndpointSpec | undefined {
  return ENDPOINTS[pathname];
}
