//! Case files: cities nobody can command. Whatever the question in one is, the answer has to come
//! from watching the city, so a build, a road or a policy that moved the answer would spoil it.

use felix_metro_core::investigation_for;

use super::World;

impl World {
    /// Whether this city is a case file. Every command that would change it is refused.
    pub(crate) fn is_case_file(&self) -> bool {
        investigation_for(&self.city.seed).is_some()
    }
}

#[cfg(test)]
mod tests;
