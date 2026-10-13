Documented the watcher pipeline split in SKILL.md §2: on platforms where the
scheduled job runs as a background worker without chat tools, the worker
runs sync/read and hands the main agent a prepared package (what to post,
where, plus the ack command); the main agent posts to the side chat and
acks. The "never ack before the report is posted" invariant is what forces
this ordering. Skill 1.1.0 → 1.2.0.
