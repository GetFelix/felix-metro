//! Prints a city as ASCII so a layout can be checked by eye.
//!
//! `cargo run --example map -- harbor 2` prints `harbor` at 2 by 2 districts.
//! Legend: `#` arterial, `+` street, `~` water, `T` the Felix tower,
//! `D` downtown, `c` commercial, `.` suburban, `i` industrial, `p` park,
//! `,` filler with no road beside it.

use felix_metro_core::{City, SegmentClass, Zone};

fn main() {
    let mut args = std::env::args().skip(1);
    let seed = args.next().unwrap_or_else(|| "harbor".into());
    let d: u16 = args.next().and_then(|a| a.parse().ok()).unwrap_or(2);
    let city = City::generate(&seed, d).expect("a valid seed and district count");
    let n = usize::from(city.tiles());
    let mut grid = vec![vec![' '; n]; n];
    for &(x, z) in &city.water {
        grid[usize::from(z)][usize::from(x)] = '~';
    }
    for lot in &city.lots {
        grid[usize::from(lot.z)][usize::from(lot.x)] = match (lot.zone, lot.door()) {
            (Zone::Park, _) => 'p',
            (_, None) => ',',
            (Zone::Downtown, _) => 'D',
            (Zone::Commercial, _) => 'c',
            (Zone::Suburban, _) => '.',
            (Zone::Industrial, _) => 'i',
        };
    }
    let tower = city.tower();
    grid[usize::from(tower.z)][usize::from(tower.x)] = 'T';
    for seg in &city.segments {
        let (a, b) = (city.nodes[seg.a as usize], city.nodes[seg.b as usize]);
        let mark = if seg.class == SegmentClass::Avenue {
            '#'
        } else {
            '+'
        };
        for x in a.0..=b.0 {
            for z in a.1..=b.1 {
                let cell = &mut grid[usize::from(z)][usize::from(x)];
                if *cell != '#' {
                    *cell = mark;
                }
            }
        }
    }
    println!("{seed} {d}x{d}, hash {:016x}", city.hash());
    for row in grid {
        println!("{}", row.into_iter().collect::<String>().trim_end());
    }
}
