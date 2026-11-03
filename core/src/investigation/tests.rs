use super::*;

#[test]
fn a_case_file_is_found_by_its_seed() {
    assert_eq!(investigation_for("ember"), Some(&INVESTIGATIONS[0]));
    assert_eq!(investigation_for("harbor"), None);
}

#[test]
fn a_case_file_is_not_a_chapter() {
    for case in &INVESTIGATIONS {
        assert_eq!(crate::chapter_for(case.seed), None);
    }
}

#[test]
fn every_case_file_city_generates_and_names_its_streets_once() {
    for case in &INVESTIGATIONS {
        let city = crate::City::generate(case.seed, case.districts_per_side).unwrap();
        let named = |name: &str| city.streets.iter().filter(|s| *s == name).count();
        assert_eq!(named(case.street), 1, "{}", case.street);
        assert_eq!(named(case.neighbour), 1, "{}", case.neighbour);
    }
}

#[test]
fn the_hint_holds_the_hour_among_two_and_a_street_that_is_not_the_answer() {
    for case in &INVESTIGATIONS {
        assert!((case.hint_from..case.hint_from + 2).contains(&case.hour));
        assert!(case.hint_from + 2 <= 24);
        assert_ne!(case.neighbour, case.street);
    }
}

#[test]
fn the_json_carries_every_field_the_page_reads() {
    assert_eq!(
        INVESTIGATIONS[0].to_json(),
        "{\"seed\":\"ember\",\"day\":0,\"hour\":7,\"street\":\"Alder\",\"purpose\":\"work\",\"hintFrom\":6,\"neighbour\":\"Oak\"}"
    );
}
