//! Case files: a city with a question in it. A case file is a seed nobody can
//! command, so its days play out the same way for everyone, and the player has
//! to work out from watching them what was busiest, where and why.
//!
//! The sim refuses every command in these cities, and the page checks the
//! player's answer against this table. The sim's tests recompute the answer from
//! the day's events, so the table cannot drift from what the city does. The page
//! reads it through `wasm::investigation`, and the sim writes it to
//! `web/src/investigation-fixture.json` for the page's tests.

#[cfg(test)]
mod tests;

use crate::schedule::Activity;

/// A case file's question and its answer.
///
/// The question is the jam: in the busiest hour of `day`, which street do the
/// most vehicle trips use, and what are the drivers on their way to do?
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Investigation {
    /// The seed of the city, which is also its name.
    pub seed: &'static str,
    /// Districts on a side.
    pub districts_per_side: u16,
    /// The city day the question is about, counted from 0.
    pub day: u32,
    /// The hour of the day in which the most trips set off, 0 to 23.
    pub hour: u32,
    /// The street the most of those trips use.
    pub street: &'static str,
    /// What the drivers set off to do.
    pub purpose: Activity,
    /// The first of the two hours the hint names. The hour is one of them.
    pub hint_from: u32,
    /// A street that crosses the answer, which the hint names. Never the answer.
    pub neighbour: &'static str,
}

impl Investigation {
    /// What the page checks answers by and shows hints from, as JSON.
    pub fn to_json(&self) -> String {
        format!(
            "{{\"seed\":\"{}\",\"day\":{},\"hour\":{},\"street\":\"{}\",\"purpose\":\"{}\",\"hintFrom\":{},\"neighbour\":\"{}\"}}",
            self.seed,
            self.day,
            self.hour,
            self.street,
            self.purpose.name(),
            self.hint_from,
            self.neighbour
        )
    }
}

/// Every case file, in the order a player meets them.
pub const INVESTIGATIONS: [Investigation; 1] = [Investigation {
    seed: "ember",
    districts_per_side: 2,
    day: 0,
    hour: 7,
    street: "Alder",
    purpose: Activity::Work,
    hint_from: 6,
    neighbour: "Oak",
}];

/// The case file whose city has this seed, if any.
pub fn investigation_for(seed: &str) -> Option<&'static Investigation> {
    INVESTIGATIONS.iter().find(|i| i.seed == seed)
}
