//! Records as JSON for the browser. Keys are camel case; a principal hash is
//! 16 hex digits because it does not fit a JavaScript number.

use std::fmt::Write;

use super::{
    Command, CommandRecord, Doing, Event, Keyframe, Leg, RegistryRecord, TickRecord, Vehicle,
};

fn text(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c < ' ' => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `items` joined by commas inside brackets.
fn list<T>(out: &mut String, items: &[T], mut each: impl FnMut(&mut String, &T)) {
    out.push('[');
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        each(out, item);
    }
    out.push(']');
}

fn route(out: &mut String, legs: &[Leg]) {
    list(out, legs, |o, l| {
        let _ = write!(o, "[{},{}]", l.segment, l.speed);
    });
}

fn vehicle(out: &mut String, v: &Vehicle) {
    let _ = write!(
        out,
        "\"vehicle\":{},\"progress\":{},\"route\":",
        v.kind, v.progress
    );
    route(out, &v.route);
}

fn event(out: &mut String, e: &Event) {
    match e {
        Event::Trip {
            resident,
            vehicle,
            depart,
            route: legs,
        } => {
            let _ = write!(
                out,
                "{{\"type\":\"trip\",\"resident\":{resident},\"vehicle\":{vehicle},\"depart\":{depart},\"route\":"
            );
            route(out, legs);
        }
        Event::Replan {
            resident,
            from_segment,
            route: legs,
        } => {
            let _ = write!(
                out,
                "{{\"type\":\"replan\",\"resident\":{resident},\"fromSegment\":{from_segment},\"route\":"
            );
            route(out, legs);
        }
        Event::Arrived { resident, lot } => {
            let _ = write!(
                out,
                "{{\"type\":\"arrived\",\"resident\":{resident},\"lot\":{lot}"
            );
        }
        Event::Activity {
            resident,
            kind,
            until,
        } => {
            let _ = write!(
                out,
                "{{\"type\":\"activity\",\"resident\":{resident},\"kind\":{kind},\"until\":{until}"
            );
        }
        Event::Left {
            resident,
            district,
            vehicle: v,
        }
        | Event::Entered {
            resident,
            district,
            vehicle: v,
        } => {
            let name = if matches!(e, Event::Left { .. }) {
                "left"
            } else {
                "entered"
            };
            let _ = write!(
                out,
                "{{\"type\":\"{name}\",\"resident\":{resident},\"district\":{district},"
            );
            vehicle(out, v);
        }
        Event::Built {
            lot,
            kind,
            rotation,
        }
        | Event::Demolished {
            lot,
            kind,
            rotation,
        } => {
            let name = if matches!(e, Event::Built { .. }) {
                "built"
            } else {
                "demolished"
            };
            let _ = write!(
                out,
                "{{\"type\":\"{name}\",\"lot\":{lot},\"kind\":{kind},\"rotation\":{rotation}"
            );
        }
        Event::Road { segment, change } => {
            let _ = write!(
                out,
                "{{\"type\":\"road\",\"segment\":{segment},\"change\":{change}"
            );
        }
        Event::Command {
            principal,
            name,
            id,
            result,
        } => {
            let _ = write!(
                out,
                "{{\"type\":\"command\",\"principal\":\"{principal:016x}\",\"name\":"
            );
            text(out, name);
            let _ = write!(out, ",\"id\":{id},\"result\":{result}");
        }
        Event::Speed { ticks_per_second } => {
            let _ = write!(
                out,
                "{{\"type\":\"speed\",\"ticksPerSecond\":{ticks_per_second}"
            );
        }
    }
    out.push('}');
}

fn keyframe(out: &mut String, k: &Keyframe) {
    out.push_str("{\"buildings\":");
    list(out, &k.buildings, |o, b| {
        let _ = write!(o, "[{},{},{}]", b.lot, b.kind, b.rotation);
    });
    out.push_str(",\"roads\":");
    list(out, &k.roads, |o, d| {
        let _ = write!(o, "[{},{}]", d.segment, d.change);
    });
    out.push_str(",\"residents\":");
    list(out, &k.residents, |o, r| {
        let _ = write!(o, "{{\"id\":{},", r.id);
        match &r.doing {
            Doing::Activity { kind, lot, until } => {
                let _ = write!(o, "\"activity\":{kind},\"lot\":{lot},\"until\":{until}");
            }
            Doing::Trip(v) => vehicle(o, v),
        }
        o.push('}');
    });
    let c = &k.counts;
    let _ = write!(
        out,
        ",\"counts\":{{\"home\":{},\"atWork\":{},\"onRoad\":{},\"asleep\":{}}}}}",
        c.home, c.at_work, c.on_road, c.asleep
    );
}

pub(super) fn tick(r: &TickRecord) -> String {
    let h = &r.header;
    let mut out = String::new();
    let _ = write!(
        out,
        "{{\"kind\":\"tick\",\"epoch\":{},\"district\":{},\"tick\":{},\"speed\":{},\"keyframeOffset\":{},\"wallUs\":{},\"keyframe\":",
        h.epoch, h.district, h.tick, h.speed, h.keyframe_offset, h.wall_us
    );
    match &r.keyframe {
        Some(k) => keyframe(&mut out, k),
        None => out.push_str("null"),
    }
    out.push_str(",\"events\":");
    list(&mut out, &r.events, event);
    out.push('}');
    out
}

pub(super) fn command(c: &CommandRecord) -> String {
    let mut out = String::new();
    let _ = write!(out, "{{\"kind\":\"command\",\"id\":{},\"name\":", c.id);
    text(&mut out, &c.name);
    out.push_str(",\"command\":");
    match &c.command {
        Command::PlaceRoad { a, b } => {
            let _ = write!(out, "{{\"type\":\"placeRoad\",\"a\":{a},\"b\":{b}}}");
        }
        Command::Zone { lot, zone } => {
            let _ = write!(out, "{{\"type\":\"zone\",\"lot\":{lot},\"zone\":{zone}}}");
        }
        Command::Build {
            lot,
            kind,
            rotation,
        } => {
            let _ = write!(
                out,
                "{{\"type\":\"build\",\"lot\":{lot},\"kind\":{kind},\"rotation\":{rotation}}}"
            );
        }
        Command::Demolish { lot } => {
            let _ = write!(out, "{{\"type\":\"demolish\",\"lot\":{lot}}}");
        }
        Command::Speed { ticks_per_second } => {
            let _ = write!(
                out,
                "{{\"type\":\"speed\",\"ticksPerSecond\":{ticks_per_second}}}"
            );
        }
        Command::Fork { tick, name } => {
            let _ = write!(out, "{{\"type\":\"fork\",\"tick\":{tick},\"name\":");
            text(&mut out, name);
            out.push('}');
        }
    }
    out.push('}');
    out
}

pub(super) fn registry(e: &RegistryRecord) -> String {
    let mut out = String::new();
    match e {
        RegistryRecord::Created {
            name,
            seed,
            districts,
            wall_us,
        } => {
            out.push_str("{\"kind\":\"registry\",\"type\":\"created\",\"name\":");
            text(&mut out, name);
            out.push_str(",\"seed\":");
            text(&mut out, seed);
            let _ = write!(out, ",\"districts\":{districts},\"wallUs\":{wall_us}}}");
        }
        RegistryRecord::Forked {
            name,
            parent,
            tick,
            wall_us,
        } => {
            out.push_str("{\"kind\":\"registry\",\"type\":\"forked\",\"name\":");
            text(&mut out, name);
            out.push_str(",\"parent\":");
            text(&mut out, parent);
            let _ = write!(out, ",\"tick\":{tick},\"wallUs\":{wall_us}}}");
        }
    }
    out
}
