"""Guard: production uses a plain postgresql:// DATABASE_URL, so the driver
SQLAlchemy picks for it must be installed. SQLAlchemy 2.1 switched that
default from psycopg2 to psycopg 3 and crash-looped production (2026-10-31).
The rest of the suite runs on SQLite and cannot catch this."""

from sqlalchemy.engine import make_url


def test_postgres_driver_for_plain_url_is_installed():
    dialect_cls = make_url("postgresql://u:p@localhost/db").get_dialect()
    dialect_cls.import_dbapi()  # raises ModuleNotFoundError if the driver is missing
