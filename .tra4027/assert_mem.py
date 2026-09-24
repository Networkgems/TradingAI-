import io, sys
sys.stdout.reconfigure(encoding='utf-8')
mem = r'C:\Users\eetienne\.claude\projects\C--Users-eetienne--paperclip-instances-default-projects-fc64eaf4-0c08-4270-9a4c-31ee16594dec-b6a879bc-aabf-4ee4-9e47-12404018a8f1--default\memory'
idx = io.open(mem + r'\MEMORY.md', encoding='utf-8')
t = idx.read()
raw = io.open(mem + r'\MEMORY.md', 'rb').read().replace(b'\r\n', b'\n')
print('LF-only', len(raw))
probes = [
    '\u27054027 (AC5\u21924797 `todo`)',
    'A TERMINAL WRITE FLIPS THE *NEXT* DOOR OPEN',
    '[[project_tra4027_export_r_instant]] \u00a7Hooks',
    'BALANCE 22T21:3xZ 24350B',
    '4534 TRIGGER+4621',
]
ok = True
for p in probes:
    hit = p in t
    ok = ok and hit
    print(('PASS ' if hit else 'FAIL ') + p)
# the retired fragment must NOT remain in the index but MUST be in the topic file
frag = '4027 mine `in_review` mon 11T20:30Z'
print('index-clear', frag not in t)
topic = io.open(mem + r'\project_tra4027_export_r_instant.md', encoding='utf-8').read()
print('topic-carries (escaped form ok)', ('4027 mine' in topic and 'mon 11T20:30Z' in topic))
print('topic-closed-desc', 'CLOSED done 2026-09-22' in topic and 'TRA-4797' in topic)
sys.exit(0 if ok else 1)
