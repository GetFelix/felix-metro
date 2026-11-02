//! The mayor's policies: shop hours and a speed limit for each road class.
//!
//! A policy changes on a `policy` command, at most once a city day for each
//! one. The values and the tick of each change ride in a `policy` event on
//! every keyframe tick, so a restart gets them back.

use felix_metro_core::TICKS_PER_DAY;
use felix_metro_core::TICKS_PER_HOUR;
use felix_metro_core::record::{
    Event, POLICIES, POLICY_AVENUE_LIMIT, POLICY_SHOP_HOURS, POLICY_STREET_LIMIT, PolicySetting,
    REFUSED_COOLDOWN, REFUSED_MALFORMED, REFUSED_UNCHANGED,
};

#[cfg(test)]
mod tests;

/// Ticks a policy must stay as set before it can change again.
pub(crate) const COOLDOWN: u32 = TICKS_PER_DAY;
/// The most hours past their usual close that shops can stay open.
const MAX_SHOP_HOURS: u8 = 3;
/// The slowest limit a road class can be given, in percent of its speed.
const MIN_LIMIT: u8 = 30;
/// Business tax a shop pays each city day for each hour it stays open late.
pub(crate) const TAX_PER_LATE_HOUR: u64 = 6;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Policy {
    settings: [PolicySetting; POLICIES],
}

impl Policy {
    /// Usual shop hours and no speed limit below the roads' own.
    pub(crate) fn new() -> Policy {
        let setting = |value| PolicySetting {
            value,
            changed: None,
        };
        let mut settings = [setting(0); POLICIES];
        settings[POLICY_AVENUE_LIMIT] = setting(100);
        settings[POLICY_STREET_LIMIT] = setting(100);
        Policy { settings }
    }

    /// The policies a `policy` event describes, or `None` for any other event.
    pub(crate) fn from_event(event: &Event) -> Option<Policy> {
        match *event {
            Event::Policy { mut settings } => {
                // A hand-written event must not hold a value the rest of the sim divides by.
                settings[POLICY_SHOP_HOURS].value =
                    settings[POLICY_SHOP_HOURS].value.min(MAX_SHOP_HOURS);
                for kind in [POLICY_AVENUE_LIMIT, POLICY_STREET_LIMIT] {
                    settings[kind].value = settings[kind].value.clamp(MIN_LIMIT, 100);
                }
                Some(Policy { settings })
            }
            _ => None,
        }
    }

    pub(crate) fn event(&self) -> Event {
        Event::Policy {
            settings: self.settings,
        }
    }

    /// Sets policy `kind` to `value` at `tick`, or says why it can't: the
    /// result code of the refusal.
    pub(crate) fn set(&mut self, kind: u8, value: u8, tick: u32) -> Result<(), u8> {
        let kind = usize::from(kind);
        let valid = match kind {
            POLICY_SHOP_HOURS => value <= MAX_SHOP_HOURS,
            POLICY_AVENUE_LIMIT | POLICY_STREET_LIMIT => (MIN_LIMIT..=100).contains(&value),
            _ => false,
        };
        if !valid {
            return Err(REFUSED_MALFORMED);
        }
        let setting = &mut self.settings[kind];
        if setting.value == value {
            return Err(REFUSED_UNCHANGED);
        }
        if setting
            .changed
            .is_some_and(|at| tick < at.saturating_add(COOLDOWN))
        {
            return Err(REFUSED_COOLDOWN);
        }
        *setting = PolicySetting {
            value,
            changed: Some(tick),
        };
        Ok(())
    }

    /// Hours shops stay open past their usual close.
    pub(crate) fn shop_hours(&self) -> u64 {
        u64::from(self.settings[POLICY_SHOP_HOURS].value)
    }

    /// How far past the usual close shopkeepers stay at work, in ticks.
    pub(crate) fn late_close(&self) -> u32 {
        u32::from(self.settings[POLICY_SHOP_HOURS].value) * TICKS_PER_HOUR
    }

    /// The speed limit on avenues and on streets, in percent of their speed.
    pub(crate) fn limits(&self) -> (u8, u8) {
        (
            self.settings[POLICY_AVENUE_LIMIT].value,
            self.settings[POLICY_STREET_LIMIT].value,
        )
    }
}
