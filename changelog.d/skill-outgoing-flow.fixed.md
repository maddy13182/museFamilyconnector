Fixed a gap in the watcher pipeline docs (skill 1.2.0): they covered the
incoming flow (worker detects → main agent posts) but not the outgoing
flow. Added: when the main agent creates a topic directly via `hub
new-topic` or `hub spawn`, it must create the side chat and update the
topic→chat mapping in the same step — the worker will never see it as
"changed" since own posts don't trigger the loop. Skill 1.2.0 → 1.2.1.
