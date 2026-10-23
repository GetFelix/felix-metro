//! Prints a summary and hash of a few generated cities, as JSON, for the web
//! tests to compare with the WebAssembly build.

use felix_metro_core::City;

fn main() {
    let cases = [("harbor", 2), ("meadow", 2), ("harbor", 4)];
    let rows: Vec<String> = cases
        .iter()
        .map(|&(seed, d)| {
            let city = City::generate(seed, d).unwrap();
            format!(
                "  {{\"seed\": \"{seed}\", \"districts\": {d}, \"lots\": {}, \"segments\": {}, \"shore\": {}, \"hash\": \"{:016x}\"}}",
                city.lots.len(),
                city.segments.len(),
                city.shore.map_or("null".to_string(), |e| e.to_string()),
                city.hash()
            )
        })
        .collect();
    println!("[\n{}\n]", rows.join(",\n"));
}
