import { isIP } from 'node:net';

const deny=()=>{throw new Error('ADDRESS');};
// Reviewed fixed IANA snapshot; no special-service exceptions. These classify
// candidates only. Actual guest routes/translators still require supplied denies.
const ipv4Denials=['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.0.0.0/24','192.0.2.0/24','192.31.196.0/24','192.52.193.0/24','192.88.99.0/24','192.168.0.0/16','192.175.48.0/24','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/4','240.0.0.0/4'];
const ipv6Allocated=['2001::/23','2001:200::/23','2001:400::/23','2001:600::/23','2001:800::/22','2001:c00::/23','2001:e00::/23','2001:1200::/23','2001:1400::/22','2001:1800::/23','2001:1a00::/23','2001:1c00::/22','2001:2000::/19','2001:4000::/23','2001:4200::/23','2001:4400::/23','2001:4600::/23','2001:4800::/23','2001:4a00::/23','2001:4c00::/23','2001:5000::/20','2001:8000::/19','2001:a000::/20','2001:b000::/20','2002::/16','2003::/18','2400::/12','2410::/12','2600::/12','2610::/23','2620::/23','2630::/12','2800::/12','2a00::/12','2a10::/12','2c00::/12'];
const ipv6Denials=['::/128','::1/128','::ffff:0:0/96','64:ff9b::/96','64:ff9b:1::/48','100::/64','100:0:0:1::/64','2001::/23','2001:db8::/32','2002::/16','2620:4f:8000::/48','3fff::/20','5f00::/16','fc00::/7','fe80::/10'];

function address(text) {
  if(typeof text!=='string'||text.length>45||text.includes('%'))deny();
  const family=isIP(text);if(!family)deny();
  if(family===4){const words=text.split('.').map(Number);return {family,bits:32,value:words.reduce((n,w)=>(n<<8n)|BigInt(w),0n),normalized:words.join('.')};}
  let source=text.toLowerCase();
  if(source.includes('.')) {
    const index=source.lastIndexOf(':'),v4=address(source.slice(index+1)).value;
    source=source.slice(0,index+1)+(v4>>16n).toString(16)+':'+(v4&65535n).toString(16);
  }
  const halves=source.split('::'),left=halves[0]?halves[0].split(':'):[],right=halves[1]?halves[1].split(':'):[];
  const words=(halves.length===2?[...left,...Array(8-left.length-right.length).fill('0'),...right]:left).map(w=>parseInt(w,16));
  if(words.length!==8)deny();
  return {family,bits:128,value:words.reduce((n,w)=>(n<<16n)|BigInt(w),0n),normalized:words.map(w=>w.toString(16)).join(':')};
}
function cidr(text) {
  if(typeof text!=='string'||text.length>64)deny();
  const parts=text.split('/');if(parts.length!==2||!/^(0|[1-9]\d{0,2})$/.test(parts[1]))deny();
  const ip=address(parts[0]),prefix=Number(parts[1]);if(prefix>ip.bits)deny();
  const shift=BigInt(ip.bits-prefix);return {family:ip.family,shift,network:ip.value>>shift};
}
const contains=(prefix,ip)=>prefix.family===ip.family&&(ip.value>>prefix.shift)===prefix.network;
const fixedDenials=[...ipv4Denials,...ipv6Denials].map(cidr),allocated=ipv6Allocated.map(cidr),gua=cidr('2000::/3');

export function validateResolved(addresses,deniedCidrs) {
  if(!Array.isArray(addresses)||addresses.length===0||addresses.length>64||!Array.isArray(deniedCidrs)||deniedCidrs.length>128)deny();
  const extra=Array.from(deniedCidrs,cidr);
  return Array.from(addresses,text=>{
    const ip=address(text);
    if((ip.family===6&&(!contains(gua,ip)||!allocated.some(prefix=>contains(prefix,ip))))||fixedDenials.some(prefix=>contains(prefix,ip))||extra.some(prefix=>contains(prefix,ip)))deny();
    return ip.normalized;
  });
}
