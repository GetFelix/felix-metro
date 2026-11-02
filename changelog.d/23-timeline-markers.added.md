- Timeline markers: a row of buttons above the timeline marks the rush hours (08:00 and 17:15 each day) and every
  building a builder put up or took down, with their name. A click seeks to the moment; marks too close together
  share one numbered button, and clicking it again goes to the next moment in it. The row is a toolbar of its own with
  an accessible name on every button. The sim writes each city day's builder markers to the events stream's state
  (`markers.<day>`, a new record kind 5 in district 0's shard, one value a day under 20 KB), in the same commit as the tick that made the change;
  tick records and their headers are unchanged. A city with no markers stored reads as before.
