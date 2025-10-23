const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_STATE = {
  branding: {
    logo: '',
  },
  employees: [
    {
      id: 'amalie-korvig',
      name: 'Amalie Korvig',
      department: 'Administration',
      role: 'Receptionist',
      photo: '',
      isCheckedIn: true,
    },
    {
      id: 'jonas-lindholm',
      name: 'Jonas Lindholm',
      department: 'Administration',
      role: 'HR-partner',
      photo: '',
      isCheckedIn: false,
    },
    {
      id: 'freja-holm',
      name: 'Freja Holm',
      department: 'Design',
      role: 'Lead Designer',
      photo: '',
      isCheckedIn: true,
    },
    {
      id: 'mathias-hagen',
      name: 'Mathias Hagen',
      department: 'Design',
      role: 'UX Designer',
      photo: '',
      isCheckedIn: false,
    },
    {
      id: 'henrik-nord',
      name: 'Henrik Nord',
      department: 'Salg',
      role: 'Salgschef',
      photo: '',
      isCheckedIn: true,
    },
    {
      id: 'sofie-iversen',
      name: 'Sofie Iversen',
      department: 'Salg',
      role: 'Account Manager',
      photo: '',
      isCheckedIn: false,
    },
  ],
  absences: [],
};

class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = deepClone(DEFAULT_STATE);
    this.queue = Promise.resolve();
  }

  async init() {
    try {
      const data = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(data);
      this.state = normaliseState(parsed);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('Kunne ikke indlæse eksisterende data, bruger standardværdier.', error);
      }
      this.state = deepClone(DEFAULT_STATE);
      await this.persist();
    }
  }

  getState() {
    return deepClone(this.state);
  }

  async setBrandingLogo(logoPath) {
    return this.enqueue(async () => {
      const previousLogo = this.state.branding?.logo || '';
      this.state = {
        ...this.state,
        branding: {
          ...this.state.branding,
          logo: logoPath,
        },
      };
      await this.persist();
      return { state: this.getState(), previousLogo };
    });
  }

  async removeBrandingLogo() {
    return this.enqueue(async () => {
      const previousLogo = this.state.branding?.logo || '';
      this.state = {
        ...this.state,
        branding: {
          ...this.state.branding,
          logo: '',
        },
      };
      await this.persist();
      return { state: this.getState(), previousLogo };
    });
  }

  async addEmployee(payload) {
    return this.enqueue(async () => {
      const employee = normaliseEmployee({
        ...payload,
        id: payload.id || crypto.randomUUID(),
        isCheckedIn: Boolean(payload.isCheckedIn),
      });
      if (!employee.name || !employee.role) {
        throw new Error('Navn og titel er påkrævet');
      }
      this.state = {
        ...this.state,
        employees: [...this.state.employees, employee],
      };
      await this.persist();
      return deepClone(employee);
    });
  }

  async updateEmployee(id, updates) {
    return this.enqueue(async () => {
      let updatedEmployee = null;
      this.state = {
        ...this.state,
        employees: this.state.employees.map((employee) => {
          if (employee.id !== id) {
            return employee;
          }
          updatedEmployee = normaliseEmployee({
            ...employee,
            ...updates,
            id: employee.id,
            isCheckedIn: typeof updates.isCheckedIn === 'boolean' ? updates.isCheckedIn : employee.isCheckedIn,
          });
          return updatedEmployee;
        }),
      };
      if (!updatedEmployee) {
        throw new Error('Medarbejder ikke fundet');
      }
      await this.persist();
      return deepClone(updatedEmployee);
    });
  }

  async removeEmployee(id) {
    return this.enqueue(async () => {
      let removedEmployee = null;
      const remainingEmployees = [];
      this.state.employees.forEach((employee) => {
        if (employee.id === id) {
          removedEmployee = employee;
          return;
        }
        remainingEmployees.push(employee);
      });
      if (!removedEmployee) {
        throw new Error('Medarbejder ikke fundet');
      }
      this.state = {
        ...this.state,
        employees: remainingEmployees,
        absences: this.state.absences.filter((absence) => absence.employeeId !== id),
      };
      await this.persist();
      return deepClone(removedEmployee);
    });
  }

  async setEmployeeStatus(id, isCheckedIn) {
    return this.enqueue(async () => {
      let updatedEmployee = null;
      this.state = {
        ...this.state,
        employees: this.state.employees.map((employee) => {
          if (employee.id !== id) {
            return employee;
          }
          updatedEmployee = { ...employee, isCheckedIn: Boolean(isCheckedIn) };
          return updatedEmployee;
        }),
      };
      if (!updatedEmployee) {
        throw new Error('Medarbejder ikke fundet');
      }
      await this.persist();
      return deepClone(updatedEmployee);
    });
  }

  async addAbsence(payload) {
    return this.enqueue(async () => {
      const absence = normaliseAbsence({
        id: payload.id || crypto.randomUUID(),
        employeeId: payload.employeeId,
        from: payload.from,
        to: payload.to,
        reason: payload.reason,
      });
      if (!absence) {
        throw new Error('Ugyldige fraværsoplysninger');
      }
      const filtered = this.state.absences.filter((entry) => entry.employeeId !== absence.employeeId);
      this.state = {
        ...this.state,
        absences: [...filtered, absence],
      };
      await this.persist();
      return deepClone(absence);
    });
  }

  async removeAbsence(id) {
    return this.enqueue(async () => {
      let removed = null;
      const absences = this.state.absences.filter((absence) => {
        if (absence.id === id) {
          removed = absence;
          return false;
        }
        return true;
      });
      if (!removed) {
        throw new Error('Fravær ikke fundet');
      }
      this.state = {
        ...this.state,
        absences,
      };
      await this.persist();
      return deepClone(removed);
    });
  }

  enqueue(task) {
    const run = this.queue.then(() => task());
    this.queue = run.then(() => undefined).catch(() => undefined);
    return run;
  }

  async persist() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2), 'utf8');
  }
}

function normaliseState(raw) {
  if (!raw || typeof raw !== 'object') {
    return deepClone(DEFAULT_STATE);
  }
  const branding = normaliseBranding(raw.branding);
  const employees = Array.isArray(raw.employees) && raw.employees.length
    ? normaliseEmployeeList(raw.employees)
    : deepClone(DEFAULT_STATE.employees);
  const validIds = new Set(employees.map((employee) => employee.id));
  const absences = Array.isArray(raw.absences)
    ? normaliseAbsenceList(raw.absences, validIds)
    : [];
  return { branding, employees, absences };
}

function normaliseBranding(raw) {
  if (!raw || typeof raw !== 'object') {
    return { logo: '' };
  }
  return {
    logo: typeof raw.logo === 'string' ? raw.logo : '',
  };
}

function normaliseEmployeeList(employees) {
  const taken = new Set();
  return employees.map((employee) => {
    const normalised = normaliseEmployee(employee);
    let candidate = normalised.id || crypto.randomUUID();
    while (taken.has(candidate)) {
      candidate = crypto.randomUUID();
    }
    normalised.id = candidate;
    taken.add(candidate);
    return normalised;
  });
}

function normaliseEmployee(employee) {
  if (!employee || typeof employee !== 'object') {
    return {
      id: crypto.randomUUID(),
      name: 'Ukendt medarbejder',
      department: 'Øvrige',
      role: '',
      photo: '',
      isCheckedIn: false,
    };
  }
  const name = typeof employee.name === 'string' && employee.name.trim() ? employee.name.trim() : 'Ukendt medarbejder';
  const department = typeof employee.department === 'string' && employee.department.trim()
    ? employee.department.trim()
    : 'Øvrige';
  const role = typeof employee.role === 'string' ? employee.role.trim() : '';
  const photo = typeof employee.photo === 'string' ? employee.photo.trim() : '';
  const id = typeof employee.id === 'string' && employee.id.trim() ? employee.id.trim() : crypto.randomUUID();
  return {
    id,
    name,
    department,
    role,
    photo,
    isCheckedIn: Boolean(employee.isCheckedIn),
  };
}

function normaliseAbsenceList(absences, validIds) {
  return absences
    .map((absence) => normaliseAbsence(absence, validIds))
    .filter(Boolean);
}

function normaliseAbsence(absence, validIds = null) {
  if (!absence || typeof absence !== 'object') {
    return null;
  }
  const employeeId = typeof absence.employeeId === 'string' ? absence.employeeId : null;
  if (!employeeId || (validIds && !validIds.has(employeeId))) {
    return null;
  }
  const from = typeof absence.from === 'string' ? absence.from : null;
  const to = typeof absence.to === 'string' ? absence.to : null;
  if (!from || !to) {
    return null;
  }
  if (new Date(from) > new Date(to)) {
    return null;
  }
  const reason = typeof absence.reason === 'string' ? absence.reason : 'other';
  const id = typeof absence.id === 'string' && absence.id.trim() ? absence.id.trim() : crypto.randomUUID();
  return { id, employeeId, from, to, reason };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = StateStore;