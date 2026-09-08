"""Dataset access: dtype drift and schema breaks.

Both failures these cover are silent-by-default. `season` shipped as Float64
makes `pl.col("season") == 2009` match nothing; a schema break unioned with
`missing_columns="insert"` returns half a table full of nulls.
"""

import polars as pl
import pytest

from nfl.data import KEY_DTYPES, SchemaBreak, UNSAFE_UNION, normalize_keys, scan


@pytest.mark.parametrize(
    "values, dtype",
    [
        ([2009.0, 2010.0], pl.Float64),   # injuries, 2009-2020
        (["2006", "2007"], pl.String),    # ff_opportunity
    ],
)
def test_key_columns_are_cast_back_to_integers(values, dtype):
    lf = pl.LazyFrame({"season": pl.Series(values, dtype=dtype), "week": [1, 2]})
    out = normalize_keys(lf).collect()
    assert out["season"].dtype == KEY_DTYPES["season"]
    # The point of the cast: an ordinary integer comparison has to work.
    assert out.filter(pl.col("season") == int(float(values[0]))).height == 1


def test_normalize_keys_leaves_correct_dtypes_alone():
    lf = pl.LazyFrame({"season": pl.Series([2020], dtype=pl.Int32), "other": ["x"]})
    assert normalize_keys(lf).collect()["season"].dtype == pl.Int32


def test_unparseable_key_becomes_null_rather_than_raising():
    lf = pl.LazyFrame({"season": ["not a season"]})
    assert normalize_keys(lf).collect()["season"][0] is None


def test_unsafe_union_datasets_refuse_to_scan():
    for name, replacement in UNSAFE_UNION.items():
        with pytest.raises(SchemaBreak, match=replacement.split(".")[-1]):
            scan(name)


def test_unsafe_union_can_be_opted_out_of():
    """The profiler reports *on* the mess, so it has to be able to read it."""
    for name in UNSAFE_UNION:
        assert isinstance(scan(name, strict=False), pl.LazyFrame)
