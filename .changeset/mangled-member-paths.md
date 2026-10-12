---
"@callstack/tracesift": patch
---

Stop `t.A` and `eK.H` from heading card rows.

The name tiers decided how much a recorded name explains by testing the whole
string for a minified identifier, which caught `t` and `_r` and let every dotted
form through. A bundle produces plenty: `t.A`, `n.Z`, `eK.H` — mangled member
paths long enough to pass that test and still naming nothing anyone can search
for. On the local trace `t.A` was 58% of a feature's time and the card named it
as the answer.

Three places already assumed otherwise. `frame-location.ts` carried its own
stricter test so it would print a file position beside such a frame, its test
said so in as many words, and `frame-classes.ts` says mangled identifiers "stay
residue for the model to decide" while promoting `t.A` to application code. That
test now lives with the tiers, so the question has one answer: every segment has
to be mangled for the name to be, which leaves `eK.useMemo` and `foo.id` alone.

What the rows say instead is the work underneath: `t.A` on the longest task
becomes `reportMatchesTodoBucket` and `buildTransactionsByReportID`. Caller
lines drop it too, which is what they always said they did.
