"""Тесты для bot.promo_copy."""

from bot.promo_copy import build_cold_outreach, build_promo_message, escape_html


def test_escape_html_none() -> None:
    assert escape_html(None) == ""


def test_escape_html_special_chars() -> None:
    assert escape_html("a & b < c > d") == "a &amp; b &lt; c &gt; d"


def test_build_cold_outreach_contains_name_and_escapes() -> None:
    text = build_cold_outreach(
        {"name": "Салон <X>", "reviews2gis": 10, "rating2gis": 4.5},
        developer_name="Dev & Co",
        median_reviews=100,
        bot_username="mybot",
    )
    assert "Салон &lt;X&gt;" in text
    assert "Dev &amp; Co" in text
    assert "10 отз" in text
    assert "@mybot" in text


def test_build_promo_message_escapes_salon_in_bold_block() -> None:
    out = build_promo_message(
        {
            "rating2gis": 5.0,
            "reviews2gis": 3,
            "ratingYandex": None,
            "reviewsYandex": None,
        },
        owner_name=None,
        salon_name="Test & <shop>",
    )
    assert "Test &amp; &lt;shop&gt;" in out
    assert "<shop>" not in out
