const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const dotenv = require('dotenv');

const StateStore = require('./stateStore');

dotenv.config();

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || 'development-secret';
const PORT = parseInt(process.env.PORT, 10) || 3000;

const uploadsRoot = path.join(__dirname, '..', 'uploads');
const brandingUploads = path.join(uploadsRoot, 'branding');
const employeeUploads = path.join(uploadsRoot, 'employees');

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const target = file.fieldname === 'logo' ? brandingUploads : employeeUploads;
    fs.mkdir(target, { recursive: true })
      .then(() => cb(null, target))
      .catch((error) => cb(error));
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname || '') || '.png';
    const id = crypto.randomUUID();
    cb(null, `${file.fieldname}-${id}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      cb(new Error('Filen skal være et billede.'));
      return;
    }
    cb(null, true);
  },
});

const app = express();
const store = new StateStore(path.join(__dirname, '..', 'data', 'state.json'));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    name: 'registrering.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  }),
);

app.use('/uploads', express.static(uploadsRoot));
app.use(express.static(path.join(__dirname, '..')));

function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    next();
    return;
  }
  res.status(401).json({ error: 'Ikke logget ind' });
}

app.get('/api/session', (req, res) => {
  res.json({ authenticated: Boolean(req.session && req.session.user) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.user = { username };
    res.json({ success: true });
    return;
  }
  res.status(401).json({ error: 'Ugyldigt brugernavn eller adgangskode' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/state', async (req, res) => {
  res.json(store.getState());
});

app.post('/api/branding/logo', requireAuth, upload.single('logo'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'Ingen fil modtaget' });
    return;
  }
  try {
    const relativePath = `/uploads/branding/${req.file.filename}`;
    const { previousLogo, state } = await store.setBrandingLogo(relativePath);
    if (previousLogo && previousLogo !== relativePath) {
      await removeFile(previousLogo);
    }
    res.json({ logo: state.branding.logo });
  } catch (error) {
    console.error('Fejl ved upload af logo', error);
    res.status(500).json({ error: 'Kunne ikke opdatere logo' });
  }
});

app.delete('/api/branding/logo', requireAuth, async (req, res) => {
  try {
    const { previousLogo } = await store.removeBrandingLogo();
    if (previousLogo) {
      await removeFile(previousLogo);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Fejl ved fjernelse af logo', error);
    res.status(500).json({ error: 'Kunne ikke fjerne logo' });
  }
});

app.post('/api/employees', requireAuth, upload.single('photo'), async (req, res) => {
  const { name, department, role } = req.body || {};
  if (!name || !role) {
    res.status(400).json({ error: 'Navn og titel er påkrævet' });
    return;
  }
  const payload = {
    name,
    department,
    role,
    photo: req.file ? `/uploads/employees/${req.file.filename}` : '',
  };
  try {
    const employee = await store.addEmployee(payload);
    res.status(201).json({ employee });
  } catch (error) {
    console.error('Kunne ikke oprette medarbejder', error);
    res.status(500).json({ error: 'Kunne ikke oprette medarbejder' });
  }
});

app.put('/api/employees/:id', requireAuth, upload.single('photo'), async (req, res) => {
  const { id } = req.params;
  const { name, department, role, removePhoto } = req.body || {};
  if (!name || !role) {
    res.status(400).json({ error: 'Navn og titel er påkrævet' });
    return;
  }
  const updates = {
    name,
    department,
    role,
  };
  if (req.file) {
    updates.photo = `/uploads/employees/${req.file.filename}`;
  } else if (removePhoto === 'true') {
    updates.photo = '';
  }
  try {
    const previousState = store.getState();
    const previousEmployee = previousState.employees.find((employee) => employee.id === id);
    const employee = await store.updateEmployee(id, updates);
    if (req.file && previousEmployee && previousEmployee.photo && previousEmployee.photo !== employee.photo) {
      await removeFile(previousEmployee.photo);
    }
    if (!req.file && updates.photo === '' && previousEmployee && previousEmployee.photo) {
      await removeFile(previousEmployee.photo);
    }
    res.json({ employee });
  } catch (error) {
    console.error('Kunne ikke opdatere medarbejder', error);
    res.status(error.message === 'Medarbejder ikke fundet' ? 404 : 500).json({ error: error.message });
  }
});

app.delete('/api/employees/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const employee = await store.removeEmployee(id);
    if (employee.photo) {
      await removeFile(employee.photo);
    }
    res.status(204).end();
  } catch (error) {
    console.error('Kunne ikke slette medarbejder', error);
    res.status(error.message === 'Medarbejder ikke fundet' ? 404 : 500).json({ error: error.message });
  }
});

app.patch('/api/employees/:id/status', async (req, res) => {
  const { id } = req.params;
  const { isCheckedIn } = req.body || {};
  try {
    const employee = await store.updateEmployee(id, { isCheckedIn: Boolean(isCheckedIn) });
    res.json({ employee });
  } catch (error) {
    const statusCode = error.message === 'Medarbejder ikke fundet' ? 404 : 500;
    res.status(statusCode).json({ error: error.message });
  }
});

app.post('/api/absences', requireAuth, async (req, res) => {
  const { employeeId, from, to, reason } = req.body || {};
  if (!employeeId || !from || !to) {
    res.status(400).json({ error: 'Medarbejder, startdato og slutdato er påkrævet' });
    return;
  }
  if (new Date(from) > new Date(to)) {
    res.status(400).json({ error: 'Slutdato skal være efter startdato' });
    return;
  }
  try {
    const currentState = store.getState();
    const employeeExists = currentState.employees.some((employee) => employee.id === employeeId);
    if (!employeeExists) {
      res.status(404).json({ error: 'Medarbejder ikke fundet' });
      return;
    }
    const absence = await store.addAbsence({ employeeId, from, to, reason: reason || 'other' });
    res.status(201).json({ absence });
  } catch (error) {
    console.error('Kunne ikke registrere fravær', error);
    res.status(500).json({ error: 'Kunne ikke registrere fravær' });
  }
});

app.delete('/api/absences/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await store.removeAbsence(id);
    res.status(204).end();
  } catch (error) {
    res.status(error.message === 'Fravær ikke fundet' ? 404 : 500).json({ error: error.message });
  }
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError || error.message === 'Filen skal være et billede.') {
    res.status(400).json({ error: error.message });
    return;
  }
  console.error('Uventet fejl', error);
  res.status(500).json({ error: 'Der opstod en uventet fejl' });
});

async function removeFile(relativePath) {
  if (!relativePath) {
    return;
  }
  const trimmed = relativePath.replace(/^\/+/, '');
  const absolute = path.join(__dirname, '..', trimmed);
  const safeRoot = path.join(__dirname, '..', 'uploads');
  if (!absolute.startsWith(safeRoot)) {
    return;
  }
  try {
    await fs.unlink(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Kunne ikke slette fil', absolute, error);
    }
  }
}

async function start() {
  await store.init();
  app.listen(PORT, () => {
    console.log(`Registrering-backend kører på http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error('Kunne ikke starte serveren', error);
  process.exit(1);
});