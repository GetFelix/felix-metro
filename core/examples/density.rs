//! Prints how many residents are on the road, by car and on foot: the city's peak per district, the
//! busiest single segment, and the frame at 08:00 and 17:15.
//!
//! `cargo run --release --example density -- harbor 2` for `harbor` at 2 by 2 districts. Roads are
//! empty, so a trip never detours around traffic.

use felix_metro_core::{City, Congestion, Mode, Places, Resident, TICKS_PER_DAY, TICKS_PER_HOUR};

fn main() {
    let mut args = std::env::args().skip(1);
    let seed = args.next().unwrap_or_else(|| "harbor".into());
    let d: u16 = args.next().and_then(|a| a.parse().ok()).unwrap_or(2);
    let city = City::generate(&seed, d).expect("a valid seed and district count");
    let places = Places::new(&city);
    let districts = city.districts.len();
    let side = u32::from(d);
    let ticks = TICKS_PER_DAY as usize;
    // Cars and walkers in each district at each tick, and cars on each segment.
    let mut cars = vec![vec![0u16; districts]; ticks];
    let mut walkers = cars.clone();
    let mut peak_segment = (0u16, 0u32, 0u32);
    let mut segment_ticks: Vec<Vec<(u32, u32)>> = vec![Vec::new(); ticks];
    let mut placed = 0;
    let mut trips_made = 0;
    for index in 0..places.population() {
        let Some(resident) = Resident::new(&city, &places, index) else {
            continue;
        };
        let Some(trips) = resident.day_trips(&city, 0, &Congestion::FREE, 0) else {
            continue;
        };
        placed += 1;
        for trip in trips {
            trips_made += 1;
            for tick in trip.depart..=trip.arrive() {
                let t = tick as usize % ticks;
                let at = trip.position_at(&city, tick);
                let column = (at.x / 1000 / 12).min(side - 1);
                let row = (at.z / 1000 / 12).min(side - 1);
                let district = (row * side + column) as usize;
                match trip.mode {
                    Mode::Drive => {
                        cars[t][district] += 1;
                        segment_ticks[t].push((at.segment, tick));
                    }
                    Mode::Walk => walkers[t][district] += 1,
                }
            }
        }
    }
    for (t, list) in segment_ticks.iter_mut().enumerate() {
        list.sort_unstable();
        let mut i = 0;
        while i < list.len() {
            let j = list[i..].iter().take_while(|s| s.0 == list[i].0).count();
            if j as u32 > peak_segment.1 {
                peak_segment = (list[i].0 as u16, j as u32, t as u32);
            }
            i += j;
        }
    }
    println!(
        "{seed} {d}x{d}: {} lots, {} residents, {placed} with a day, {trips_made} trips",
        city.lots.len(),
        places.population()
    );
    let total = |v: &Vec<Vec<u16>>, t: usize| v[t].iter().map(|&n| u32::from(n)).sum::<u32>();
    let peak_total = |v: &Vec<Vec<u16>>| (0..ticks).map(|t| total(v, t)).max().unwrap_or(0);
    println!(
        "peak on the road: cars {}, walkers {}",
        peak_total(&cars),
        peak_total(&walkers)
    );
    for dist in 0..districts {
        let cp = (0..ticks).map(|t| cars[t][dist]).max().unwrap_or(0);
        let wp = (0..ticks).map(|t| walkers[t][dist]).max().unwrap_or(0);
        println!("district {dist}: peak cars {cp:3}, peak walkers {wp:3}");
    }
    let (seg, n, t) = peak_segment;
    println!(
        "busiest segment: {seg} ({:?}), {n} cars at {:02}:{:02}",
        city.segments[seg as usize].class,
        t / TICKS_PER_HOUR,
        t % TICKS_PER_HOUR * 60 / TICKS_PER_HOUR
    );
    // Average over each quarter hour around the two peaks, as a camera dwelling there sees it.
    for (label, hour, minute) in [("08:00", 8, 0), ("17:15", 17, 15)] {
        let at = (hour * TICKS_PER_HOUR + minute * TICKS_PER_HOUR / 60) as usize;
        let window = at - 30..at + 30;
        let mean = |v: &Vec<Vec<u16>>, dist: usize| {
            window.clone().map(|t| u32::from(v[t][dist])).sum::<u32>() as f32 / window.len() as f32
        };
        let line = |v: &Vec<Vec<u16>>| {
            (0..districts)
                .map(|dist| format!("{:5.1}", mean(v, dist)))
                .collect::<Vec<_>>()
                .join(" ")
        };
        println!(
            "{label}  cars by district [{}]  walkers by district [{}]",
            line(&cars),
            line(&walkers)
        );
    }
}
