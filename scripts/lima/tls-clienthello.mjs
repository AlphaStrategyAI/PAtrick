import { isIP } from 'node:net';

const deny=()=>{throw new Error('TLS');};
const more=Object.freeze({status:'need-more'}),incomplete=Symbol('incomplete');
const maximum=65536;

// Missing low bytes can only increase an unsigned network-order length.
function checkLengthPrefix(data,offset,width,limit) {
  let minimum=0;
  for(let i=0;i<width;i++)minimum=minimum*256+(data[offset+i]??0);
  if(minimum>limit)deny();
}

function serverName(data,length) {
  if(length<6)deny();
  checkLengthPrefix(data,0,2,length-2);
  if(data.length<2)throw incomplete;
  if(data.readUInt16BE(0)!==length-2)deny();
  if(data.length<3)throw incomplete;
  if(data[2]!==0)deny();
  checkLengthPrefix(data,3,2,Math.min(253,length-5));
  if(data.length<5)throw incomplete;
  const size=data.readUInt16BE(3);if(size===0||size>253||size!==length-5)deny();
  const name=data.subarray(5);let labelLength=0,previous;
  for(const byte of name) {
    if(byte===46){if(!labelLength||previous===45)deny();labelLength=0;}
    else {
      if(!((byte>=97&&byte<=122)||(byte>=48&&byte<=57)||(byte===45&&labelLength>0)))deny();
      if(++labelLength>63)deny();
    }
    previous=byte;
  }
  if(data.length<length)throw incomplete;
  const hostname=name.toString('ascii');
  if(!labelLength||previous===45||!hostname.includes('.')||isIP(hostname)||/^\d+(?:\.\d+)*$/.test(hostname))deny();
  return hostname;
}
function clientHello(body,length) {
  let offset=0;
  const take=n=>{
    if(offset+n>length)deny();
    if(offset+n>body.length)throw incomplete;
    const value=body.subarray(offset,offset+n);offset+=n;return value;
  };
  const byte=()=>take(1)[0],word=()=>take(2).readUInt16BE();
  const vectorLength=()=>{checkLengthPrefix(body,offset,2,length-offset-2);return word();};
  if(word()!==0x0303)deny();take(32);
  const session=byte();if(session>32)deny();take(session);
  const ciphers=vectorLength();if(ciphers<2||ciphers%2)deny();take(ciphers);
  const compression=byte();if(compression!==1||byte()!==0)deny();
  const extensionsLength=vectorLength();if(extensionsLength!==length-offset)deny();
  const seen=new Set();let hostname;
  while(offset<length) {
    const type=word();
    if(seen.has(type)||[65037,64768,65486].includes(type))deny();seen.add(type);
    const size=vectorLength();if(offset+size>length)deny();
    if(type===0)hostname=serverName(body.subarray(offset,Math.min(offset+size,body.length)),size);
    take(size);
  }
  if(!hostname)deny();return {status:'ok',hostname};
}

export function readClientHelloSni(bytes) {
  if(!(bytes instanceof Uint8Array)||bytes.byteLength>maximum)deny();
  const raw=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength),parts=[],header=Buffer.alloc(4);
  let offset=0,total=0,overhead=0,expected;
  function prefix() {
    checkLengthPrefix(header.subarray(0,Math.min(total,4)),1,3,maximum-overhead-4);
    if(total<4)return more;
    try {return clientHello(Buffer.concat(parts,total).subarray(4),expected-4);}
    catch(error){if(error===incomplete)return more;throw error;}
  }
  while(offset<raw.length) {
    const left=raw.length-offset;
    if(raw[offset]!==22||(left>=2&&raw[offset+1]!==3)||(left>=3&&![1,3].includes(raw[offset+2])))deny();
    overhead+=5;
    checkLengthPrefix(raw,offset+3,2,Math.min(16384,maximum-offset-5,expected===undefined?maximum:expected-total));
    if(left<5){prefix();return more;}
    const length=raw.readUInt16BE(offset+3);if(length===0||length>16384)deny();
    const available=Math.min(length,left-5),fragment=raw.subarray(offset+5,offset+5+available);
    if(total<4)fragment.copy(header,total,0,Math.min(available,4-total));
    if(total+available>=1&&header[0]!==1)deny();
    checkLengthPrefix(header.subarray(0,Math.min(total+available,4)),1,3,maximum-overhead-4);
    if(total+available>=4) {
      expected=4+header.readUIntBE(1,3);
      if(expected<47||expected>maximum-5||total+length>expected)deny();
    }
    parts.push(fragment);total+=available;
    if(available<length){prefix();return more;}
    offset+=5+length;
    if(expected!==undefined&&total===expected) {
      if(offset!==raw.length)deny();
      return prefix();
    }
  }
  prefix();return more;
}
