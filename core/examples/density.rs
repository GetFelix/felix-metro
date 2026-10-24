//! Prints how many residents are on the road, by car and on foot, for each half hour of a day.
//!
//! `cargo run --release --example density -- harbor 2` for `harbor` at 2 by 2 districts.

use felix_metro_core::{City, Congestion, Mode, Places, Resident, TICKS_PER_DAY, TICKS_PER_HOUR};

fn main() {
    let mut args = std::env::args().skip(1);
    let seed = args.next().unwrap_or_else(|| "harbor".into());
    let d: u16 = args.next().and_then(|a| a.parse().ok()).unwrap_or(2);
    let city = City::generate(&seed, d).expect("a valid seed and district count");
    let places = Places::new(&city);
    let step = TICKS_PER_HOUR / 2;
    let mut cars = vec![0u32; (TICKS_PER_DAY / step) as usize];
    let mut walkers = cars.clone();
    let mut placed = 0;
    for index in 0..places.population() {
        let Some(resident) = Resident::new(&city, &places, index) else {
            continue;
        };
        let Some(trips) = resident.day_trips(&city, 0, &Congestion::FREE, 0) else {
            continue;
        };
        placed += 1;
        for trip in trips {
            for tick in (trip.depart..=trip.arrive()).filter(|t| t % step == 0) {
                if let Some(slot) = ((tick / step) as usize).checked_rem(cars.len()) {
                    match trip.mode {
                        Mode::Drive => cars[slot] += 1,
                        Mode::Walk => walkers[slot] += 1,
                    }
                }
            }
        }
    }
    println!(
        "{seed} {d}x{d}: {} lots, {} residents, {placed} with a day",
        city.lots.len(),
        places.population()
    );
    for (i, (c, w)) in cars.iter().zip(&walkers).enumerate() {
        println!(
            "{:02}:{:02}  cars {c:4}  walkers {w:4}",
            i as u32 / 2,
            i % 2 * 30
        );
    }
}
