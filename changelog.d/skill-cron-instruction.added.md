- Skill: §2 (Discovery) now instructs the agent to *set up* its watch, not
  just intend it — create a recurring/scheduled job that runs `hub sync`
  about every 15 minutes and surfaces new entries per the §9 notification
  contract, or tell the human plainly if the platform has no scheduling.
  Previously the skill said "run it on your schedule" without ever telling
  the agent to create the schedule, so agents on platforms without one
  silently never polled.
