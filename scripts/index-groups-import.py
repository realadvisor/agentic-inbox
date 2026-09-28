import argparse,json,re,hashlib,os
from pathlib import Path
from email.parser import BytesHeaderParser
from collections import Counter
parser=argparse.ArgumentParser(description='Index one explicitly selected Privacy or Info MBOX; never import a whole Groups export.')
parser.add_argument('--name', choices=['privacy','info'], required=True)
parser.add_argument('--mbox', required=True)
parser.add_argument('--output', required=True)
args=parser.parse_args()
os.umask(0o077)
base=Path(args.output).resolve()
base.mkdir(parents=True,exist_ok=True,mode=0o700)
# Preserve the exported MIME bytes, including MBOX quoting. No guessed conversion.
for name,path in [(args.name,Path(args.mbox).resolve(strict=True))]:
 rows=[]; identities=Counter(); quoted=0; deeper=0; pos=0; start=None; head=[]; inhead=False; digest=hashlib.sha256()
 def finish(end):
  if start is None:return
  h=BytesHeaderParser().parsebytes(b''.join(head))
  been=[v.split(';')[0].strip().lower() for v in h.get_all('X-BeenThere',[])]
  matched=name+'@realadvisor.com' in been
  identities['matched' if matched else 'unverified']+=1
  rows.append(dict(index=len(rows),start=start,end=end,bytes=end-start,verified=matched))
 with path.open('rb') as f:
  for line in f:
   digest.update(line)
   if line.startswith(b'From '):
    finish(pos)
    if not re.match(br'^From \S+ (Mon|Tue|Wed|Thu|Fri|Sat|Sun) ',line):raise ValueError('Unexpected delimiter')
    start=pos+len(line);head=[];inhead=True
   elif inhead:
    if not line.strip():inhead=False
    else:head.append(line)
   else:
    quoted+=bool(re.match(br'^>From ',line));deeper+=bool(re.match(br'^>>+From ',line))
   pos+=len(line)
 finish(pos)
 out=dict(name=name,path=str(path.resolve()),bytes=pos,sha256=digest.hexdigest(),identity=dict(identities),quotedFrom=quoted,deeperFrom=deeper,messages=rows)
 (base/(name+'-index.json')).write_text(json.dumps(out))
 (base/(name+'-index.json')).chmod(0o600)
 print(json.dumps({k:v for k,v in out.items() if k not in ('messages','path','sha256')}),flush=True)
