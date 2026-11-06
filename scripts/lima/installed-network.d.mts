export const networkProbeIds: readonly [
 'network-direct-ip443','network-dns-udp','network-dns-tcp',
 'network-public-ipv6','network-loopback-ipv6','network-host-alias',
 'network-host-ip','network-lan','network-gateway','network-resolver',
 'network-vpn','network-metadata','network-other-loopback',
 'network-other-provider-port','network-disallowed-host',
 'network-alternate-port','network-ip-connect','network-wrong-sni',
 'network-ech','network-empty-codex','network-empty-dsh'
];
export type NetworkProbeId = typeof networkProbeIds[number];
export type NetworkCoverage = {
 targets:number; attempted:number; denied:number;
 basis:'socket-policy'|'empty-allowlist'|'no-inventory-target'|'ipv6-upstream-disabled'|'nonempty-allowlist';
 gate:'nft'|'proxy-header'|'proxy-tls'|'inventory';
};
export type InstalledNetworkResult = {
 id:NetworkProbeId; role:'grok'|'codex'|'dsh';
 status:'pass'|'fail'|'not_run'|'not_applicable';
 reason:'ok'|'not_run'|'dependency'|'identity'|'trust'|'policy'|'network'|'tls'|'lifetime'|'control_unavailable'|'unexpected_output'|'not_applicable';
 actualGuest:boolean; synthetic:true; environment:'installed';
 profile:'authenticated-client'; network:NetworkCoverage;
};
export type InstalledNetworkControl = {
 version:1; operation:'qualification-network'; outcome:'pass'|'fail';
 reason:'ok'|'dependency'|'trust'|'network'|'lifetime';
 synthetic:true; environment:'installed'; actualGuest:boolean;
 artifactHash:string;policyHash:string;inventoryHash:string;
 preconditionRequests:{header:0|1;tls:0|1};
 results:InstalledNetworkResult[];
};
// Root-private controller bindings deliberately do not cross the host ABI.
export function runInstalledNetwork(state:unknown,session:unknown,deps:unknown):Promise<InstalledNetworkControl>;
