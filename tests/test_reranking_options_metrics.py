from evaluation.evaluate_reranking_options import apply_current
from evaluation.reranking_options.metrics import (
    RetrievedDoc,
    check_expectations,
    choose_rerank_cutoff,
    filter_by_min_score,
    mrr_at_k,
    recall_at_k,
)


def _doc(**kwargs) -> RetrievedDoc:
    values = {
        "doc_id": "id",
        "score": 0.6,
        "text": "body",
        "title": "Title",
        "author": "Author",
        "library": "ananda.org",
        "metadata": {},
    }
    values.update(kwargs)
    return RetrievedDoc(**values)


def test_min_score_cutoff_drops_low_hits() -> None:
    docs = [_doc(score=0.61), _doc(score=0.49, title="low")]
    kept = filter_by_min_score(docs, 0.5)
    assert [doc.score for doc in kept] == [0.61]


def test_title_scope_skips_min_score() -> None:
    docs = [
        _doc(
            score=0.4706,
            title="The Bible:: New Testament:: Book of Matthew:: Chapter 5",
        )
    ]
    kept = apply_current(docs, {"skip_min_retrieval_score": True}, 0.5)
    assert len(kept) == 1


def test_counseling_library_expectation() -> None:
    docs = [
        _doc(library="ananda.org", title="Counseling 1"),
        _doc(library="ananda.org", title="Counseling 2"),
    ]
    result = check_expectations(
        docs, {"min_sources": 1, "library_min": {"ananda.org": 2}}
    )
    assert result.passed is True


def test_karma_diversity_expectation() -> None:
    docs = [
        _doc(author="Nayaswami Devi Novak", library="ananda.org", title="Karma A"),
        _doc(author="Nayaswami Jyotish Novak", library="ananda.org", title="Karma B"),
    ]
    result = check_expectations(
        docs,
        {
            "min_sources": 2,
            "diverse_teachers": True,
            "exclude_authors_must_not_cover_all": [
                "Paramhansa Yogananda",
                "Swami Kriyananda",
            ],
        },
    )
    assert result.passed is True


def test_recall_and_mrr() -> None:
    ranked = ["a", "x", "b"]
    relevant = ["b", "c"]
    assert recall_at_k(ranked, relevant, 3) == 0.5
    assert mrr_at_k(ranked, relevant, 3) == 1.0 / 3


def test_rerank_cutoff_prefers_higher_f1() -> None:
    labeled = [
        ([2.0, 1.0, 0.1], [True, False, False]),
        ([1.5, 0.2], [True, False]),
    ]
    cutoff, f1 = choose_rerank_cutoff(labeled, [0.0, 0.5, 1.2, 3.0])
    assert cutoff == 1.2
    assert f1 > 0.9
