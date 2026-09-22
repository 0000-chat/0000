# An authenticated actor is required for compaction

Compaction requires an authenticated actor; a thread without one must never be compacted. Authentication is a prerequisite because it makes the actor attributable for eventual approval, but it does not by itself establish thread membership or independent voters; voting rules remain undecided.
