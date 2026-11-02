- A `policy` command sets shop hours (0 to 3 hours later than usual) or the speed limit on avenues or on streets
  (30 to 100 percent of their speed). Later hours keep shopkeepers at work longer and raise shop tax; a limit slows
  every trip that drives that class of road. Each policy can change once a city day, otherwise the command is refused
  (result 11; result 12 for the value it already has). The sim writes a `policy` event when one changes and on every
  keyframe tick, and a restart restores the values and cooldowns. The page lists them under the council.
