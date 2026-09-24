"""TRA-3839 - build an ASCII-clean JSON body and assert the round trip.

Board API mangles every codepoint outside cp1252, server-side, silently, and a
comment cannot be edited afterwards. So: assert pure ASCII BEFORE the post, and
compare len(returned.body) to len(source) AFTER it.
"""
import io, json, os, sys, subprocess

src = sys.argv[1]
out = sys.argv[2]
body = io.open(src, encoding='utf-8').read()
bad = sorted({c for c in body if ord(c) >= 128})
if bad:
    raise SystemExit('NON-ASCII PRESENT, refusing to post: %r' % bad)
io.open(out, 'w', encoding='utf-8').write(json.dumps({'body': body}, ensure_ascii=True))
print('ascii-clean; chars=%d' % len(body))
