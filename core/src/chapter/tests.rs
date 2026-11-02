use super::*;

#[test]
fn a_chapter_is_found_by_its_seed() {
    assert_eq!(chapter_for("pier"), Some(&CHAPTERS[0]));
    assert_eq!(chapter_for("harbor"), None);
}

#[test]
fn every_chapter_city_generates() {
    for chapter in &CHAPTERS {
        let city = crate::City::generate(chapter.seed, chapter.districts_per_side).unwrap();
        assert_eq!(city.seed, chapter.seed);
    }
}
