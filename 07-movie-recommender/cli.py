#!/usr/bin/env python3
"""Command line interface for the movie recommender.

Examples
--------
    python cli.py recommend --title "Inception" --n 10
    python cli.py recommend --user 42 --method svd
    python cli.py recommend --user 42 --title "Alien" --method hybrid --alpha 0.6 --why
    python cli.py predict --user 42 --title "The Matrix"
    python cli.py search "matrix"
    python cli.py info
    python cli.py evaluate
"""

from __future__ import annotations

import argparse
import sys
import textwrap

import pandas as pd

from src.collaborative import ItemItemCF, SVDRecommender
from src.content_based import ContentBasedRecommender, TitleNotFoundError
from src.data_loader import dataset_summary, load_data
from src.hybrid import HybridRecommender

METHODS = ("content", "cf", "svd", "hybrid")


# ----------------------------------------------------------------- printing
def render_table(df: pd.DataFrame, max_width: int = 46) -> str:
    """Render a DataFrame as a bordered ASCII table."""
    if df.empty:
        return "(no results)"

    def fmt(v: object) -> str:
        if isinstance(v, float):
            return f"{v:.3f}"
        text = str(v)
        return text if len(text) <= max_width else text[: max_width - 1] + "…"

    headers = [str(c) for c in df.columns]
    rows = [[fmt(v) for v in row] for row in df.itertuples(index=False)]
    widths = [max(len(headers[i]), *(len(r[i]) for r in rows)) for i in range(len(headers))]
    numeric = [pd.api.types.is_numeric_dtype(df[c]) for c in df.columns]

    def line(left: str, mid: str, right: str) -> str:
        return left + mid.join("─" * (w + 2) for w in widths) + right

    def render(cells: list[str], align_numeric: bool) -> str:
        out = []
        for cell, width, is_num in zip(cells, widths, numeric):
            out.append(cell.rjust(width) if (align_numeric and is_num) else cell.ljust(width))
        return "│ " + " │ ".join(out) + " │"

    parts = [line("┌", "┬", "┐"), render(headers, False), line("├", "┼", "┤")]
    parts += [render(r, True) for r in rows]
    parts.append(line("└", "┴", "┘"))
    return "\n".join(parts)


def _wrap(text: str, indent: str = "    ", width: int = 96) -> str:
    return textwrap.fill(text, width=width, initial_indent=indent, subsequent_indent=indent + "  ")


# --------------------------------------------------------------- commands
def cmd_recommend(args: argparse.Namespace) -> int:
    data = load_data()
    titles = dict(zip(data.movies["movie_id"], data.movies["title"]))

    if not args.title and args.user is None:
        print("error: give --title, --user or both", file=sys.stderr)
        return 2

    method = args.method
    explanations: dict[int, str] = {}

    if method == "content":
        if not args.title:
            print("error: --method content requires --title", file=sys.stderr)
            return 2
        rec = ContentBasedRecommender(data.movies)
        result = rec.recommend(args.title, n=args.n)
        seed_id = data.id_of(result.attrs.get("matched_title", result["matched_title"].iloc[0])) if len(result) else None
        header = f"Content-based recommendations for '{result['matched_title'].iloc[0]}'" if len(result) else "no results"
        if args.why and seed_id is not None:
            explanations = {int(m): rec.explain_text(seed_id, int(m)) for m in result["movie_id"]}
        table = result[["rank", "title", "year", "genres", "director", "vote_average", "score"]]

    elif method in ("cf", "svd"):
        if args.user is None:
            print(f"error: --method {method} requires --user", file=sys.stderr)
            return 2
        model = (ItemItemCF() if method == "cf" else SVDRecommender()).fit(data.ratings, data.movies["movie_id"])
        known = model.ui.has_user(args.user)
        result = model.recommend(args.user, n=args.n)
        result["title"] = result["movie_id"].map(titles)
        merged = result.merge(data.movies[["movie_id", "year", "genres", "director"]], on="movie_id", how="left")
        merged = merged.rename(columns={"score": "pred_rating"})
        table = merged[["rank", "title", "year", "genres", "director", "pred_rating"]]
        label = "item-item CF" if method == "cf" else f"SVD (k={model.n_components_})"
        header = f"{label} recommendations for user {args.user}" + ("" if known else " [unknown user -> item means]")

    else:  # hybrid
        hybrid = HybridRecommender(data=data, alpha=args.alpha, cf_model=args.cf_model)
        result = hybrid.recommend(user_id=args.user, title=args.title, n=args.n, alpha=args.alpha)
        header = "Hybrid recommendations"
        if args.user is not None:
            header += f" for user {args.user}"
        if args.title:
            header += f" seeded on '{args.title}'"
        header += f"  [{result.attrs['method']}]"
        if args.why:
            explanations = {
                int(m): hybrid.explain(int(m), user_id=args.user, title=args.title) for m in result["movie_id"]
            }
        table = result[["rank", "title", "year", "genres", "score", "content_score", "cf_score", "popularity"]]

    print()
    print(header)
    print(render_table(table))
    if explanations:
        print("\nwhy this?")
        for rank, movie_id in enumerate(table_movie_ids(result), start=1):
            print(f"  {rank:>2}. {titles.get(movie_id, movie_id)}")
            print(_wrap(explanations.get(movie_id, ""), indent="      "))
    print()
    return 0


def table_movie_ids(df: pd.DataFrame) -> list[int]:
    return [int(m) for m in df["movie_id"]]


def cmd_predict(args: argparse.Namespace) -> int:
    data = load_data()
    content = ContentBasedRecommender(data.movies)
    movie_id = int(args.movie) if args.movie is not None else int(
        data.movies.iloc[content.resolve_title(args.title)]["movie_id"]
    )
    cf = ItemItemCF().fit(data.ratings, data.movies["movie_id"])
    svd = SVDRecommender().fit(data.ratings, data.movies["movie_id"])
    title = data.title_of(movie_id)
    print()
    print(f"Predicted rating for user {args.user} on '{title}'")
    print(render_table(pd.DataFrame([
        {"model": "item-item CF", "prediction": cf.predict(args.user, movie_id)},
        {"model": "SVD", "prediction": svd.predict(args.user, movie_id)},
    ])))
    actual = data.ratings[(data.ratings.user_id == args.user) & (data.ratings.movie_id == movie_id)]
    if not actual.empty:
        print(f"\n(actual rating in the dataset: {float(actual.iloc[0]['rating']):.1f})")
    print()
    return 0


def cmd_search(args: argparse.Namespace) -> int:
    data = load_data()
    q = args.query.lower()
    hits = data.movies[data.movies["title"].str.lower().str.contains(q, regex=False)]
    if hits.empty:
        rec = ContentBasedRecommender(data.movies)
        suggestions = rec.suggest(args.query, n=args.n)
        print(f"no title contains {args.query!r}." + (f" Did you mean: {', '.join(suggestions)}?" if suggestions else ""))
        return 1
    print(render_table(hits.head(args.n)[["movie_id", "title", "year", "genres", "director", "vote_average"]]))
    return 0


def cmd_info(args: argparse.Namespace) -> int:
    data = load_data()
    print(dataset_summary(data))
    genres = data.movies["genres"].str.split("|").explode().value_counts()
    print("\ngenres:")
    print(render_table(genres.reset_index().set_axis(["genre", "movies"], axis=1)))
    return 0


def cmd_evaluate(args: argparse.Namespace) -> int:
    from src.evaluate import run

    run(k=args.k)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cli.py",
        description="Movie recommendation system",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    rec = sub.add_parser("recommend", help="recommend movies")
    rec.add_argument("--title", "-t", type=str, help="seed movie title (fuzzy matched)")
    rec.add_argument("--user", "-u", type=int, help="user id")
    rec.add_argument("--n", "-n", type=int, default=10, help="how many recommendations (default 10)")
    rec.add_argument("--method", "-m", choices=METHODS, default="hybrid")
    rec.add_argument("--alpha", "-a", type=float, default=0.5, help="hybrid weight: 1=content, 0=collaborative")
    rec.add_argument("--cf-model", choices=("svd", "item"), default="svd", help="collaborative model inside the hybrid")
    rec.add_argument("--why", action="store_true", help="print an explanation for each recommendation")
    rec.set_defaults(func=cmd_recommend)

    pred = sub.add_parser("predict", help="predict one user's rating for one movie")
    pred.add_argument("--user", "-u", type=int, required=True)
    pred.add_argument("--title", "-t", type=str)
    pred.add_argument("--movie", type=int, help="movie_id instead of --title")
    pred.set_defaults(func=cmd_predict)

    search = sub.add_parser("search", help="search the catalogue by title")
    search.add_argument("query")
    search.add_argument("--n", "-n", type=int, default=15)
    search.set_defaults(func=cmd_search)

    info = sub.add_parser("info", help="dataset summary")
    info.set_defaults(func=cmd_info)

    ev = sub.add_parser("evaluate", help="run the offline evaluation")
    ev.add_argument("--k", type=int, default=10)
    ev.set_defaults(func=cmd_evaluate)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except TitleNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except BrokenPipeError:  # e.g. `python cli.py info | head`
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
