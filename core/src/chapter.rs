//! Chapters: a city with a story. A chapter is a seed whose city opens with
//! something the mayor has to fix, and a goal to reach by a deadline.
//!
//! The sim applies the opening and the page judges the goal. The two must agree
//! on the numbers, so this table is the one place they live. The page reads it
//! through `wasm::chapter`, and the sim writes it to `web/src/chapter-fixture.json`
//! for the page's tests.

#[cfg(test)]
mod tests;

/// A chapter's opening state and the commute it asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Chapter {
    /// The seed of the chapter's city, which is also its name.
    pub seed: &'static str,
    /// Districts on a side.
    pub districts_per_side: u16,
    /// Speed limit on avenues when the chapter opens, in percent of their speed.
    pub opening_avenue_limit: u8,
    /// Speed limit on streets when the chapter opens.
    pub opening_street_limit: u8,
    /// City days the mayor has: the goals are judged when this many have been scored.
    pub days: u32,
    /// The longest average trip to work or school, in ticks, that meets the commute goal.
    pub commute_ticks: u32,
}

impl Chapter {
    /// The numbers the page judges the goals by, as JSON.
    pub fn to_json(&self) -> String {
        format!(
            "{{\"seed\":\"{}\",\"days\":{},\"commuteTicks\":{}}}",
            self.seed, self.days, self.commute_ticks
        )
    }
}

/// Every chapter, in the order a player meets them.
pub const CHAPTERS: [Chapter; 1] = [Chapter {
    seed: "pier",
    districts_per_side: 2,
    opening_avenue_limit: 40,
    opening_street_limit: 60,
    days: 3,
    commute_ticks: 64,
}];

/// The chapter whose city has this seed, if any.
pub fn chapter_for(seed: &str) -> Option<&'static Chapter> {
    CHAPTERS.iter().find(|c| c.seed == seed)
}
