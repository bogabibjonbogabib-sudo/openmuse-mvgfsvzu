import getpass
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import time
from functools import lru_cache
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

import pymupdf


ROOT = Path(__file__).resolve().parent
DATABASE = Path(os.environ.get("DDK_LIBRARY_DB", ROOT / "library.sqlite3"))
BOOKS_DIRECTORY = ROOT / "китобхо"
SESSION_SECONDS = 7 * 24 * 60 * 60
PASSWORD_ROUNDS = 310_000
MAX_BODY_SIZE = 64 * 1024
LOGIN_ATTEMPTS = {}
PUBLIC_FILES = {"/", "/index.html", "/app.js", "/style.css", "/images.jfif", "/police-college-emblem.png", "/library-photo.png"}


def connect_database():
    DATABASE.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize_database():
    with connect_database() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                phone TEXT NOT NULL UNIQUE,
                login TEXT UNIQUE,
                role TEXT NOT NULL CHECK (role IN ('admin', 'student', 'teacher')),
                password_salt BLOB NOT NULL,
                password_hash BLOB NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
            """
        )
        user_columns = {row["name"] for row in connection.execute("PRAGMA table_info(users)")}
        if "login" not in user_columns:
            connection.execute("ALTER TABLE users ADD COLUMN login TEXT")
        users = connection.execute("SELECT id, role, login FROM users ORDER BY id").fetchall()
        for user in users:
            if user["login"]:
                continue
            candidate = "admin" if user["role"] == "admin" else f"user{user['id']}"
            existing = connection.execute("SELECT 1 FROM users WHERE login = ?", (candidate,)).fetchone()
            if existing:
                candidate = f"user{user['id']}"
            connection.execute("UPDATE users SET login = ? WHERE id = ?", (candidate, user["id"]))
        connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS users_login_unique ON users(login)")


def normalize_login(value):
    login = str(value).strip().lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{2,31}", login):
        raise ValueError("Login must be 3 to 32 letters, numbers, dots, dashes, or underscores.")
    return login


def make_password_hash(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ROUNDS)
    return salt, digest


def verify_password(password, salt, expected_hash):
    _, actual_hash = make_password_hash(password, salt)
    return hmac.compare_digest(actual_hash, expected_hash)


def create_user(login, password, role):
    login = normalize_login(login)
    if role not in {"admin", "student", "teacher"}:
        raise ValueError("Invalid account role.")
    if len(password) < 10 or len(password) > 128:
        raise ValueError("Password must contain 10 to 128 characters.")
    salt, password_hash = make_password_hash(password)
    with connect_database() as connection:
        cursor = connection.execute(
            "INSERT INTO users (phone, login, role, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (f"login:{login}", login, role, salt, password_hash, int(time.time())),
        )
        return cursor.lastrowid


def create_admin_from_terminal(login):
    initialize_database()
    password = getpass.getpass("Пароли админ (камаш 10 аломат): ")
    confirmation = getpass.getpass("Паролро такрор кунед: ")
    if password != confirmation:
        raise ValueError("Паролҳо мувофиқат намекунанд.")
    user_id = create_user(login, password, "admin")
    print(f"Админ сохта шуд (ID: {user_id}). Парол дар базаи маълумот нигоҳ дошта намешавад.")


def reset_admin_password_from_terminal(login):
    login = normalize_login(login)
    password = getpass.getpass("Пароли нави админ (камаш 10 аломат): ")
    confirmation = getpass.getpass("Пароли навро такрор кунед: ")
    if password != confirmation:
        raise ValueError("Паролҳо мувофиқат намекунанд.")
    if len(password) < 10 or len(password) > 128:
        raise ValueError("Парол бояд аз 10 то 128 аломат бошад.")

    salt, password_hash = make_password_hash(password)
    with connect_database() as connection:
        account = connection.execute(
            "SELECT id FROM users WHERE login = ? AND role = 'admin'", (login,)
        ).fetchone()
        if not account:
            raise ValueError(f"Ҳисоби админ бо логини '{login}' ёфт нашуд.")
        connection.execute(
            "UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?",
            (salt, password_hash, account["id"]),
        )
        connection.execute("DELETE FROM sessions WHERE user_id = ?", (account["id"],))

    print(f"Пароли админ '{login}' нав шуд. Акнун бо пароли нав ворид шавед.")


@lru_cache(maxsize=96)
def render_book_cover(file_path, modified_ns):
    with pymupdf.open(file_path) as document:
        if document.page_count == 0:
            raise ValueError("PDF has no pages.")
        page = document.load_page(0)
        bounds = page.rect
        scale = min(0.7, 320 / bounds.width, 440 / bounds.height)
        if scale <= 0:
            raise ValueError("PDF page has invalid dimensions.")
        return page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False).tobytes("png")


class LibraryHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format_string, *args):
        if self.path.startswith("/api/"):
            return
        super().log_message(format_string, *args)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/books":
            self.list_books()
            return
        if path.startswith("/api/books/cover/"):
            self.send_book_cover(path.removeprefix("/api/books/cover/"))
            return
        if path.startswith("/api/books/file/"):
            self.send_book_file(path.removeprefix("/api/books/file/"))
            return
        if path == "/api/session":
            user = self.current_user()
            if not user:
                self.send_json(200, {"authenticated": False})
                return
            self.send_json(200, self.public_user(user))
            return
        if path not in PUBLIC_FILES:
            self.send_json(404, {"error": "Not found."})
            return
        super().do_GET()

    def require_authenticated(self):
        if not self.current_user():
            self.send_json(401, {"error": "Барои дидани китобхона аввал ворид шавед."})
            return False
        return True

    def catalog_pdf(self, encoded_name):
        name = unquote(encoded_name)
        if not name or Path(name).name != name or "\\" in name or not name.lower().endswith(".pdf"):
            return None
        candidate = BOOKS_DIRECTORY / name
        if not candidate.is_file() or candidate.parent.resolve() != BOOKS_DIRECTORY.resolve():
            return None
        return candidate

    def list_books(self):
        if not self.require_authenticated():
            return
        if not BOOKS_DIRECTORY.is_dir():
            self.send_json(500, {"error": "Ҷузвдони китобҳо ёфт нашуд."})
            return
        result = []
        for book in sorted(BOOKS_DIRECTORY.glob("*"), key=lambda item: item.name.casefold()):
            if not book.is_file() or book.suffix.lower() != ".pdf":
                continue
            encoded_name = quote(book.name, safe="")
            result.append({
                "id": book.name,
                "title": re.sub(r"\s+", " ", book.stem.replace("_", " ")).strip(),
                "category": "Фонди коллеҷ",
                "coverUrl": f"/api/books/cover/{encoded_name}",
                "pdfUrl": f"/api/books/file/{encoded_name}",
            })
        self.send_json(200, result)

    def send_book_cover(self, encoded_name):
        if not self.require_authenticated():
            return
        book = self.catalog_pdf(encoded_name)
        if not book:
            self.send_json(404, {"error": "Китоб ёфт нашуд."})
            return
        try:
            image = render_book_cover(str(book), book.stat().st_mtime_ns)
        except (pymupdf.FileDataError, RuntimeError, ValueError):
            self.send_json(422, {"error": "Муқоваи ин файли PDF сохта нашуд."})
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(image)))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(image)

    def send_book_file(self, encoded_name):
        if not self.require_authenticated():
            return
        book = self.catalog_pdf(encoded_name)
        if not book:
            self.send_json(404, {"error": "Китоб ёфт нашуд."})
            return
        size = book.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", f"inline; filename*=UTF-8''{quote(book.name, safe='')}")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        with book.open("rb") as source:
            while chunk := source.read(64 * 1024):
                self.wfile.write(chunk)

    def do_POST(self):
        path = urlsplit(self.path).path
        if path == "/api/login":
            self.login()
        elif path == "/api/register":
            self.register()
        elif path == "/api/logout":
            self.logout()
        elif path == "/api/admin/credentials":
            self.update_admin_credentials()
        else:
            self.send_json(404, {"error": "Not found."})

    def do_DELETE(self):
        self.send_json(404, {"error": "Not found."})

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("Invalid request size.") from None
        if length <= 0 or length > MAX_BODY_SIZE:
            raise ValueError("Invalid request size.")
        try:
            return json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ValueError("Invalid request data.") from None

    def send_json(self, status, data, headers=None):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if headers:
            for name, value in headers.items():
                self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    @staticmethod
    def public_user(user):
        return {"authenticated": True, "id": user["id"], "login": user["login"], "role": user["role"]}

    def current_user(self):
        cookies = self.headers.get("Cookie", "").split(";")
        token = next((part.split("=", 1)[1].strip() for part in cookies if part.strip().startswith("ddk_session=")), None)
        if not token:
            return None
        token_hash = hashlib.sha256(token.encode("ascii", errors="ignore")).hexdigest()
        with connect_database() as connection:
            connection.execute("DELETE FROM sessions WHERE expires_at < ?", (int(time.time()),))
            return connection.execute(
                "SELECT users.id, users.login, users.role FROM sessions JOIN users ON users.id = sessions.user_id "
                "WHERE sessions.token_hash = ? AND sessions.expires_at >= ?",
                (token_hash, int(time.time())),
            ).fetchone()

    def require_admin(self):
        user = self.current_user()
        if not user or user["role"] != "admin":
            self.send_json(403, {"error": "Administrator access required."})
            return False
        return True

    def login(self):
        now = time.time()
        client = self.client_address[0]
        try:
            data = self.read_json()
            login = normalize_login(data.get("login", ""))
            password = str(data.get("password", ""))
        except (ValueError, AttributeError):
            self.send_json(400, {"error": "Enter your login and password."})
            return
        attempts = [attempt for attempt in LOGIN_ATTEMPTS.get(client, []) if now - attempt < 60]
        if len(attempts) >= 10:
            self.send_json(429, {"error": "Too many attempts. Try again in one minute."})
            return
        with connect_database() as connection:
            user = connection.execute("SELECT * FROM users WHERE login = ?", (login,)).fetchone()
        if not user or not verify_password(password, user["password_salt"], user["password_hash"]):
            attempts.append(now)
            LOGIN_ATTEMPTS[client] = attempts
            self.send_json(401, {"error": "Login or password is incorrect."})
            return
        LOGIN_ATTEMPTS.pop(client, None)
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
        with connect_database() as connection:
            connection.execute(
                "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
                (token_hash, user["id"], int(now) + SESSION_SECONDS),
            )
        self.send_json(
            200,
            self.public_user(user),
            {"Set-Cookie": f"ddk_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_SECONDS}"},
        )

    def register(self):
        try:
            data = self.read_json()
            login = normalize_login(data.get("login", ""))
            password = str(data.get("password", ""))
            confirmation = str(data.get("confirmation", ""))
            if len(password) < 10 or len(password) > 128:
                raise ValueError("Password must contain 10 to 128 characters.")
            if password != confirmation:
                raise ValueError("Passwords do not match.")
        except (ValueError, AttributeError):
            self.send_json(400, {"error": "Check the login and password. Passwords must match and contain 10 to 128 characters."})
            return

        try:
            user_id = create_user(login, password, "student")
        except sqlite3.IntegrityError:
            self.send_json(409, {"error": "Login is already in use."})
            return

        now = int(time.time())
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
        with connect_database() as connection:
            connection.execute(
                "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
                (token_hash, user_id, now + SESSION_SECONDS),
            )
        self.send_json(
            200,
            {"authenticated": True, "id": user_id, "login": login, "role": "student"},
            {"Set-Cookie": f"ddk_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_SECONDS}"},
        )

    def logout(self):
        user = self.current_user()
        if user:
            cookies = self.headers.get("Cookie", "").split(";")
            token = next((part.split("=", 1)[1].strip() for part in cookies if part.strip().startswith("ddk_session=")), None)
            if token:
                token_hash = hashlib.sha256(token.encode("ascii", errors="ignore")).hexdigest()
                with connect_database() as connection:
                    connection.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
        self.send_json(
            200,
            {"ok": True},
            {"Set-Cookie": "ddk_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"},
        )

    def update_admin_credentials(self):
        user = self.current_user()
        if not user or user["role"] != "admin":
            self.send_json(403, {"error": "Administrator access required."})
            return
        try:
            data = self.read_json()
            login = normalize_login(data.get("login", ""))
            current_password = str(data.get("current_password", ""))
            new_password = str(data.get("new_password", ""))
            if new_password and (len(new_password) < 10 or len(new_password) > 128):
                raise ValueError("Password must contain 10 to 128 characters.")
            if login == user["login"] and not new_password:
                raise ValueError("At least one credential must change.")
        except (ValueError, AttributeError):
            self.send_json(400, {"error": "Check the login and new password length."})
            return

        with connect_database() as connection:
            account = connection.execute("SELECT * FROM users WHERE id = ? AND role = 'admin'", (user["id"],)).fetchone()
            if not account or not verify_password(current_password, account["password_salt"], account["password_hash"]):
                self.send_json(401, {"error": "Current password is incorrect."})
                return
            try:
                if new_password:
                    salt, password_hash = make_password_hash(new_password)
                    connection.execute(
                        "UPDATE users SET login = ?, phone = ?, password_salt = ?, password_hash = ? WHERE id = ?",
                        (login, f"login:{login}", salt, password_hash, user["id"]),
                    )
                else:
                    connection.execute(
                        "UPDATE users SET login = ?, phone = ? WHERE id = ?",
                        (login, f"login:{login}", user["id"]),
                    )
            except sqlite3.IntegrityError:
                self.send_json(409, {"error": "Login is already in use."})
                return
            connection.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))

        self.send_json(
            200,
            {"ok": True, "login": login},
            {"Set-Cookie": "ddk_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"},
        )

def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    initialize_database()
    if len(sys.argv) > 1 and sys.argv[1] == "create-admin":
        login = sys.argv[2] if len(sys.argv) > 2 else input("Логини админ: ")
        create_admin_from_terminal(login)
        return
    if len(sys.argv) > 1 and sys.argv[1] == "reset-admin":
        login = sys.argv[2] if len(sys.argv) > 2 else input("Логини админ: ")
        reset_admin_password_from_terminal(login)
        return
    host = os.environ.get("DDK_HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer((host, port), LibraryHandler)
    print(f"Китобхона дар http://{host}:{port} дастрас аст")
    print("Барои қатъ кардани сервер Ctrl+C пахш кунед.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nСервер қатъ шуд.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()