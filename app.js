const DATABASE_NAME = "ddk-digital-library";
const DATABASE_VERSION = 1;
const STORE_NAME = "books";
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_COVER_SIZE = 5 * 1024 * 1024;
const BOOKS_PER_PAGE = 24;
const DEFAULT_CATEGORIES = ["Ҳама", "Фонди коллеҷ", "Адабиёти бадеӣ", "Илмҳои гуманитарӣ", "Илмҳои табиӣ", "Илмҳои техникӣ", "Иқтисодиёт", "Ҳуқуқшиносӣ", "Дастурҳои методӣ", "Дигар"];

const form = document.getElementById("book-form");
const fileInput = document.getElementById("pdf-file");
const fileLabel = document.getElementById("file-label");
const coverInput = document.getElementById("cover-file");
const coverLabel = document.getElementById("cover-label");
const searchInput = document.getElementById("search");
const grid = document.getElementById("book-grid");
const adminBookList = document.getElementById("admin-book-list");
const filters = document.getElementById("filters");
const status = document.getElementById("catalog-status");
const message = document.getElementById("form-message");
const reader = document.getElementById("reader");
const pdfFrame = document.getElementById("pdf-frame");
const loginForm = document.getElementById("login-form");
const loginMessage = document.getElementById("login-message");
const registerForm = document.getElementById("register-form");
const registerMessage = document.getElementById("register-message");
const credentialsForm = document.getElementById("credentials-form");
const credentialsMessage = document.getElementById("credentials-message");
let database;
let books = [];
let serverBooks = [];
let visibleBookLimit = BOOKS_PER_PAGE;
let selectedCategory = "Ҳама";
let activeFileUrl = null;
const coverUrls = new Set();
let currentUser = null;

async function apiRequest(path, options = {}) {
  if (window.location.protocol === "file:") {
    const error = new Error("The app must be served over HTTP.");
    error.status = 0;
    throw error;
  }
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers }
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "Дархост иҷро нашуд.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function enterLibrary(user) {
  currentUser = user;
  document.body.classList.remove("admin-login-open");
  document.body.classList.add("authenticated");
  document.body.classList.toggle("administrator", user.role === "admin");
  document.getElementById("account-label").textContent = `${user.login} · ${user.role === "admin" ? "Админ" : user.role === "teacher" ? "Омӯзгор" : "Донишҷӯ"}`;
  if (user.role === "admin") document.getElementById("admin-new-login").value = user.login;
}

function showLoginError(error) {
  if (error.status === 401) return "Логин ё парол нодуруст аст.";
  if (error.status === 429) return "Кӯшишҳо зиёд шуданд. Пас аз як дақиқа такрор кунед.";
  if (error.status === 409) return "Ин логин аллакай истифода шудааст.";
  if (error.status === 403) return "Барои ин амал иҷозат надоред.";
  if (error.status === 0) return "Барои коркарди воридшавӣ лоиҳа бояд ба сервери HTTP таъмин карда шавад. Серверро кушоед.";
  return "Пайвастшавӣ ба сервер имкон надод. Серверро санҷед.";
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
      store.createIndex("title", "title");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readBooks() {
  const transaction = database.transaction(STORE_NAME, "readonly");
  books = await requestResult(transaction.objectStore(STORE_NAME).getAll());
  renderBooks();
}

async function readServerBooks() {
  const response = await fetch("/api/books", { credentials: "same-origin" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Феҳристи китобҳои сервер бор карда нашуд.");
  if (!Array.isArray(result)) throw new Error("Ҷавоби феҳристи китобҳо нодуруст аст.");
  serverBooks = result;
}

function catalogBooks() {
  return [...books, ...serverBooks];
}

function renderFilters() {
  const categories = [...new Set([...DEFAULT_CATEGORIES, ...catalogBooks().map(book => book.category)])];
  filters.replaceChildren();
  categories.forEach(category => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `filter-chip${category === selectedCategory ? " active" : ""}`;
    button.textContent = category;
    button.setAttribute("aria-pressed", String(category === selectedCategory));
    button.addEventListener("click", () => {
      selectedCategory = category;
      visibleBookLimit = BOOKS_PER_PAGE;
      renderBooks();
    });
    filters.append(button);
  });
}

function createBookCard(book) {
  const card = document.createElement("article");
  card.className = "book-card";

  const cover = document.createElement("div");
  cover.className = "book-cover";
  if (book.cover || book.coverUrl) {
    const image = document.createElement("img");
    image.className = "book-cover-image";
    image.src = book.coverUrl || URL.createObjectURL(book.cover);
    image.loading = "lazy";
    image.decoding = "async";
    image.alt = `Муқоваи китоб: ${book.title}`;
    if (book.cover) coverUrls.add(image.src);
    cover.append(image);
  } else {
    cover.classList.add("book-cover-placeholder");
    cover.setAttribute("role", "img");
    cover.setAttribute("aria-label", `Муқоваи ороишӣ: ${book.title}`);
    const emblem = document.createElement("span");
    emblem.className = "book-cover-emblem";
    emblem.setAttribute("aria-hidden", "true");
    emblem.textContent = "К";
    const coverTitle = document.createElement("strong");
    coverTitle.className = "book-cover-title";
    coverTitle.textContent = book.title;
    cover.append(emblem, coverTitle);
  }

  const category = document.createElement("span");
  category.className = "book-category";
  category.textContent = book.category;

  const title = document.createElement("h3");
  title.textContent = book.title;
  const author = document.createElement("p");
  author.className = "book-author";
  author.textContent = book.author ? `Муаллиф: ${book.author}` : "Муаллиф нишон дода нашудааст";

  const actions = document.createElement("div");
  actions.className = "book-actions";
  const readButton = document.createElement("button");
  readButton.type = "button";
  readButton.className = "button button-primary";
  readButton.textContent = "Хондан";
  readButton.addEventListener("click", () => openBook(book));
  actions.append(readButton);
  card.append(cover, category, title, author, actions);
  return card;
}

function renderAdminBooks() {
  adminBookList.replaceChildren();
  document.getElementById("admin-book-count").textContent = `${books.length} китоб`;
  if (books.length === 0) {
    const empty = document.createElement("p");
    empty.className = "admin-empty";
    empty.textContent = "Ҳоло китоб ворид нашудааст.";
    adminBookList.append(empty);
    return;
  }
  books.forEach(book => {
    const row = document.createElement("div");
    row.className = "admin-book-row";
    const details = document.createElement("div");
    details.className = "admin-book-details";
    const title = document.createElement("strong");
    title.textContent = book.title;
    const metadata = document.createElement("span");
    metadata.textContent = `${book.author || "Муаллиф нишон дода нашудааст"} · ${book.category}`;
    details.append(title, metadata);
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "button button-quiet";
    deleteButton.textContent = "Ҳазф";
    deleteButton.setAttribute("aria-label", `Ҳазфи китоби ${book.title}`);
    deleteButton.addEventListener("click", () => deleteBook(book));
    row.append(details, deleteButton);
    adminBookList.append(row);
  });
}

function renderBooks() {
  const allBooks = catalogBooks();
  const query = searchInput.value.trim().toLocaleLowerCase("tg");
  const matchingBooks = allBooks.filter(book => {
    const matchesCategory = selectedCategory === "Ҳама" || book.category === selectedCategory;
    const searchable = `${book.title} ${book.author} ${book.category}`.toLocaleLowerCase("tg");
    return matchesCategory && (!query || searchable.includes(query));
  });
  const visibleBooks = matchingBooks.slice(0, visibleBookLimit);
  document.getElementById("total-count").textContent = String(allBooks.length);
  renderFilters();
  coverUrls.forEach(url => URL.revokeObjectURL(url));
  coverUrls.clear();
  grid.replaceChildren();
  if (visibleBooks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = allBooks.length ? "Аз рӯйи ҷустуҷӯ китоб ёфт нашуд." : "Ҳоло китоб илова нашудааст. Аз панели админ PDF интихоб кунед.";
    grid.append(empty);
  } else {
    visibleBooks.forEach(book => grid.append(createBookCard(book)));
  }
  const loadMoreButton = document.getElementById("load-more-books");
  loadMoreButton.hidden = visibleBooks.length >= matchingBooks.length;
  renderAdminBooks();
  status.textContent = `${visibleBooks.length} аз ${matchingBooks.length} китоб нишон дода мешавад`;
}

async function addBook(book) {
  const transaction = database.transaction(STORE_NAME, "readwrite");
  await requestResult(transaction.objectStore(STORE_NAME).add(book));
  await readBooks();
}

async function deleteBook(book) {
  if (currentUser?.role !== "admin") return;
  if (!window.confirm(`Китоби «${book.title}» ҳазф шавад?`)) return;
  const transaction = database.transaction(STORE_NAME, "readwrite");
  await requestResult(transaction.objectStore(STORE_NAME).delete(book.id));
  await readBooks();
  message.textContent = "Китоб ҳазф шуд.";
  message.classList.remove("error");
}

function openBook(book) {
  if (activeFileUrl) URL.revokeObjectURL(activeFileUrl);
  activeFileUrl = book.pdfUrl ? null : URL.createObjectURL(book.file);
  document.getElementById("reader-title").textContent = book.title;
  pdfFrame.src = book.pdfUrl || activeFileUrl;
  reader.showModal();
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  fileLabel.textContent = file ? file.name : "Интихоби файли PDF";
  const titleInput = document.getElementById("title");
  if (file && !titleInput.value.trim()) titleInput.value = file.name.replace(/\.pdf$/i, "");
  message.textContent = "";
  message.classList.remove("error");
  if (file && file.size > MAX_FILE_SIZE) {
    message.textContent = "Андозаи PDF аз 100 МБ зиёд аст.";
    message.classList.add("error");
    fileInput.value = "";
    fileLabel.textContent = "Интихоби файли PDF";
  }
});

coverInput.addEventListener("change", () => {
  const file = coverInput.files[0];
  coverLabel.textContent = file ? file.name : "Интихоби муқова (ихтиёрӣ)";
  message.textContent = "";
  message.classList.remove("error");
  if (file && (file.size > MAX_COVER_SIZE || !["image/jpeg", "image/png", "image/webp"].includes(file.type))) {
    message.textContent = "Муқова бояд JPG, PNG ё WebP ва то 5 МБ бошад.";
    message.classList.add("error");
    coverInput.value = "";
    coverLabel.textContent = "Интихоби муқова (ихтиёрӣ)";
  }
});

function setAuthMode(mode) {
  const registering = mode === "register";
  loginForm.hidden = registering;
  registerForm.hidden = !registering;
  document.getElementById("auth-title").textContent = registering
    ? "Ҳисоб созед."
    : "Ба китобхона ворид шавед.";
  loginMessage.textContent = "";
  registerMessage.textContent = "";
  (registering ? document.getElementById("register-login") : document.getElementById("login-name")).focus();
}

loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  loginMessage.textContent = "";
  try {
    const user = await apiRequest("/api/login", {
      method: "POST",
      body: JSON.stringify({
        login: document.getElementById("login-name").value,
        password: document.getElementById("login-password").value
      })
    });
    loginForm.reset();
    enterLibrary(user);
    await initLibrary();
  } catch (error) {
    loginMessage.textContent = showLoginError(error);
    document.getElementById("login-password").value = "";
  }
});

document.querySelector(".user-login-link").addEventListener("click", event => {
  event.preventDefault();
  document.body.classList.add("admin-login-open");
  setAuthMode("login");
});

document.getElementById("show-register").addEventListener("click", () => setAuthMode("register"));
document.getElementById("show-login").addEventListener("click", () => setAuthMode("login"));

registerForm.addEventListener("submit", async event => {
  event.preventDefault();
  registerMessage.textContent = "";
  registerMessage.classList.remove("error");
  const password = document.getElementById("register-password").value;
  const confirmation = document.getElementById("register-confirm-password").value;
  if (password !== confirmation) {
    registerMessage.textContent = "Паролҳо мувофиқат намекунанд.";
    registerMessage.classList.add("error");
    return;
  }
  try {
    const user = await apiRequest("/api/register", {
      method: "POST",
      body: JSON.stringify({
        login: document.getElementById("register-login").value,
        password,
        confirmation
      })
    });
    registerForm.reset();
    enterLibrary(user);
    await initLibrary();
  } catch (error) {
    registerMessage.textContent = error.status === 409
      ? "Ин логин аллакай истифода мешавад."
      : error.status === 400
        ? "Логинро дуруст ворид кунед ва пароли камаш 10-аломатиро такрор намоед."
        : showLoginError(error);
    registerMessage.classList.add("error");
  }
});

document.getElementById("cancel-admin-login").addEventListener("click", () => {
  if (!currentUser) return;
  document.body.classList.remove("admin-login-open");
  loginMessage.textContent = "";
  registerMessage.textContent = "";
  document.getElementById("login-password").value = "";
  registerForm.reset();
});

document.querySelectorAll(".password-toggle").forEach(button => {
  button.addEventListener("click", () => {
    const passwordInput = document.getElementById(button.dataset.passwordTarget);
    const isVisible = passwordInput.type === "password";
    passwordInput.type = isVisible ? "text" : "password";
    button.setAttribute("aria-pressed", String(isVisible));
    button.setAttribute("aria-label", isVisible ? "Пинҳон кардани парол" : "Нишон додани парол");
    button.title = isVisible ? "Пинҳон кардани парол" : "Нишон додани парол";
  });
});

document.getElementById("logout-button").addEventListener("click", async () => {
  try {
    await apiRequest("/api/logout", { method: "POST", body: "{}" });
  } finally {
    document.body.classList.remove("authenticated", "administrator", "admin-login-open");
    currentUser = null;
  }
});

credentialsForm.addEventListener("submit", async event => {
  event.preventDefault();
  credentialsMessage.textContent = "";
  credentialsMessage.classList.remove("error");
  const newPassword = document.getElementById("admin-new-password").value;
  const confirmation = document.getElementById("admin-confirm-password").value;
  if (newPassword && newPassword !== confirmation) {
    credentialsMessage.textContent = "Пароли нав ва такрори он мувофиқат намекунанд.";
    credentialsMessage.classList.add("error");
    return;
  }
  if (!newPassword && document.getElementById("admin-new-login").value.trim().toLowerCase() === currentUser?.login) {
    credentialsMessage.textContent = "Логин ё пароли навро тағйир диҳед.";
    credentialsMessage.classList.add("error");
    return;
  }
  try {
    const result = await apiRequest("/api/admin/credentials", {
      method: "POST",
      body: JSON.stringify({
        current_password: document.getElementById("admin-current-password").value,
        login: document.getElementById("admin-new-login").value,
        new_password: newPassword
      })
    });
    currentUser = null;
    document.body.classList.remove("authenticated", "administrator");
    credentialsForm.reset();
    loginForm.reset();
    document.getElementById("login-name").value = result.login;
    document.body.classList.add("admin-login-open");
    loginMessage.textContent = "Маълумот иваз шуд. Бо логин ва пароли нав ворид шавед.";
  } catch (error) {
    credentialsMessage.textContent = error.status === 401
      ? "Пароли ҳозира нодуруст аст."
      : error.status === 409
        ? "Ин логин аллакай истифода мешавад."
        : error.status === 400
          ? "Логин ё дарозии пароли нав нодуруст аст."
          : error.status
            ? showLoginError(error)
            : "Тағйири маълумот иҷро нашуд. Серверро санҷед.";
    credentialsMessage.classList.add("error");
  }
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (currentUser?.role !== "admin") return;
  const file = fileInput.files[0];
  const cover = coverInput.files[0];
  if (!file || file.size > MAX_FILE_SIZE || (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf"))) {
    message.textContent = "Лутфан файли дурусти PDF интихоб кунед.";
    message.classList.add("error");
    return;
  }
  if (cover && (cover.size > MAX_COVER_SIZE || !["image/jpeg", "image/png", "image/webp"].includes(cover.type))) {
    message.textContent = "Муқова бояд JPG, PNG ё WebP ва то 5 МБ бошад.";
    message.classList.add("error");
    return;
  }
  const titleValue = document.getElementById("title").value.trim() || file.name.replace(/\.pdf$/i, "");
  try {
    await addBook({
      title: titleValue,
      author: document.getElementById("author").value.trim(),
      category: document.getElementById("category").value,
      file,
      cover,
      fileName: file.name,
      addedAt: Date.now()
    });
    form.reset();
    fileLabel.textContent = "Интихоби файли PDF";
    coverLabel.textContent = "Интихоби муқова (ихтиёрӣ)";
    message.textContent = "Китоб бомуваффақият илова шуд.";
    message.classList.remove("error");
    selectedCategory = "Ҳама";
  } catch (error) {
    message.textContent = error.name === "QuotaExceededError" ? "Ҷойи нигоҳдорӣ кофӣ нест. PDF-и хурдтар интихоб кунед." : "Китоб нигоҳ дошта нашуд. Саҳифаро тавассути localhost кушоед.";
    message.classList.add("error");
  }
});

searchInput.addEventListener("input", () => {
  visibleBookLimit = BOOKS_PER_PAGE;
  renderBooks();
});
document.getElementById("load-more-books").addEventListener("click", () => {
  visibleBookLimit += BOOKS_PER_PAGE;
  renderBooks();
});
document.getElementById("close-reader").addEventListener("click", () => reader.close());
reader.addEventListener("close", () => {
  pdfFrame.removeAttribute("src");
  if (activeFileUrl) URL.revokeObjectURL(activeFileUrl);
  activeFileUrl = null;
});

async function initLibrary() {
  try {
    database = await openDatabase();
    await readBooks();
    await readServerBooks();
    renderBooks();
  } catch {
    status.textContent = "Китобҳо бор карда нашуданд. Серверро санҷед ва саҳифаро нав кунед.";
    document.getElementById("form-message").textContent = "Пайвастшавӣ ба феҳристи китобҳо имкон надод.";
    document.getElementById("form-message").classList.add("error");
  }
}

async function init() {
  setAuthMode("register");
  try {
    const user = await apiRequest("/api/session");
    if (user.authenticated) {
      enterLibrary(user);
      await initLibrary();
    }
  } catch {
    registerMessage.textContent = "Пайвастшавӣ ба сервер имкон надод. Серверро санҷед.";
    registerMessage.classList.add("error");
  }
}

init();