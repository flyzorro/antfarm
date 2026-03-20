import crypto from "node:crypto";
import { getDb } from "./db.js";

export interface CompanyRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

function mapCompanyRow(row: any): CompanyRecord {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createCompany(name: string): CompanyRecord {
  const normalizedName = name.trim();
  if (!normalizedName) {
    throw new Error("Company name is required");
  }

  const db = getDb();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  db.prepare(
    `INSERT INTO companies (id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?)`
  ).run(id, normalizedName, now, now);

  return { id, name: normalizedName, createdAt: now, updatedAt: now };
}

export function listCompanies(): CompanyRecord[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, name, created_at, updated_at
     FROM companies
     ORDER BY created_at ASC, id ASC`
  ).all() as any[];

  return rows.map(mapCompanyRow);
}
