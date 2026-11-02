- The sim records who built each building. On every keyframe tick each district writes an `author` event (event tag
  14: a builder's hash and name and the lots they built that still stand, with the tick each was built) per builder
  and district, so a page that starts from a keyframe can say who built what. A restart restores them from the newest
  keyframe tick and the `command` and `built` events after it. Each lot costs 2 to 5 bytes an hour (under 0.1 B/s) and
  a test holds the evening rush under the 10 KB/s goal with 150 built lots added. A city nobody has built in writes
  none, so the log-size figures are for that city.
