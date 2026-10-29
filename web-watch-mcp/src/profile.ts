import { z } from "zod";
import { JsonFile } from "./storage/json-file.js";

const customAnswerSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
]);

const locationSchema = z.object({
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  remoteOk: z.boolean().optional(),
});

const linksSchema = z.object({
  linkedin: z.string().optional(),
  github: z.string().optional(),
  portfolio: z.string().optional(),
  website: z.string().optional(),
  other: z.array(z.string()).optional(),
});

const workAuthorizationSchema = z.object({
  authorizedToWork: z.boolean().optional(),
  requiresSponsorship: z.boolean().optional(),
  citizenship: z.string().optional(),
  status: z.string().optional(),
  explanation: z.string().optional(),
});

const availabilitySchema = z.object({
  startDate: z.string().optional(),
  noticePeriod: z.string().optional(),
  availableImmediately: z.boolean().optional(),
});

const compensationSchema = z.object({
  desiredSalary: z.number().optional(),
  minimumSalary: z.number().optional(),
  currency: z.string().optional(),
  period: z.enum(["year", "month", "hour"]).optional(),
  negotiable: z.boolean().optional(),
  notes: z.string().optional(),
});

const experienceSchema = z.object({
  company: z.string().optional(),
  title: z.string().optional(),
  location: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  current: z.boolean().optional(),
  description: z.string().optional(),
  highlights: z.array(z.string()).optional(),
});

const educationSchema = z.object({
  school: z.string().optional(),
  degree: z.string().optional(),
  field: z.string().optional(),
  location: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  grade: z.string().optional(),
});

const certificationSchema = z.object({
  name: z.string().optional(),
  issuer: z.string().optional(),
  issued: z.string().optional(),
  expires: z.string().optional(),
  credentialId: z.string().optional(),
  url: z.string().optional(),
});

const languageSchema = z.object({
  name: z.string().optional(),
  proficiency: z.string().optional(),
});

const eeoSchema = z.object({
  gender: z.string().optional(),
  raceEthnicity: z.string().optional(),
  veteranStatus: z.string().optional(),
  disabilityStatus: z.string().optional(),
  pronouns: z.string().optional(),
});

export const profileSchema = z.object({
  fullName: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  preferredName: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  location: locationSchema.optional(),
  links: linksSchema.optional(),
  headline: z.string().optional(),
  summary: z.string().optional(),
  skills: z.array(z.string()).optional(),
  experience: z.array(experienceSchema).optional(),
  education: z.array(educationSchema).optional(),
  certifications: z.array(certificationSchema).optional(),
  languages: z.array(languageSchema).optional(),
  workAuthorization: workAuthorizationSchema.optional(),
  availability: availabilitySchema.optional(),
  compensation: compensationSchema.optional(),
  eeo: eeoSchema.optional(),
  customAnswers: z.record(z.string(), customAnswerSchema).optional(),
  rawNotes: z.string().optional(),
});

export type Profile = z.infer<typeof profileSchema>;

export const profilePatchSchema = profileSchema.strict();

const profileFileSchema = z.object({
  profile: profileSchema.default({}),
  updatedAt: z.string().default(() => new Date(0).toISOString()),
});

export type ProfileFile = z.infer<typeof profileFileSchema>;

export interface MissingField {
  field: string;
  label: string;
}

const REQUIRED_FIELDS: Array<{ field: string; label: string; present: (profile: Profile) => boolean }> = [
  { field: "fullName", label: "Full name", present: (profile) => Boolean(profile.fullName) },
  { field: "email", label: "Email", present: (profile) => Boolean(profile.email) },
  { field: "phone", label: "Phone", present: (profile) => Boolean(profile.phone) },
  {
    field: "location",
    label: "Location",
    present: (profile) => Boolean(profile.location?.city || profile.location?.region),
  },
  {
    field: "workAuthorization",
    label: "Work authorization",
    present: (profile) => typeof profile.workAuthorization?.authorizedToWork === "boolean",
  },
  {
    field: "compensation",
    label: "Salary expectation",
    present: (profile) =>
      typeof profile.compensation?.desiredSalary === "number" ||
      Boolean(profile.compensation?.notes),
  },
];

export function missingProfileFields(profile: Profile): MissingField[] {
  return REQUIRED_FIELDS.filter((entry) => !entry.present(profile)).map(({ field, label }) => ({
    field,
    label,
  }));
}

export class ProfileStore {
  private readonly file: JsonFile<ProfileFile>;

  constructor(filePath: string) {
    this.file = new JsonFile(filePath, profileFileSchema, () => ({
      profile: {},
      updatedAt: new Date(0).toISOString(),
    }));
  }

  async get(): Promise<ProfileFile & { isEmpty: boolean; missingFields: MissingField[] }> {
    const current = await this.file.read();
    return {
      ...current,
      isEmpty: Object.keys(current.profile).length === 0,
      missingFields: missingProfileFields(current.profile),
    };
  }

  async update(patch: Profile, replace = false): Promise<ProfileFile> {
    return this.file.update((current) => {
      const profile = replace ? patch : mergeDeep(current.profile, patch);
      return {
        profile,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async clear(): Promise<ProfileFile> {
    return this.update({}, true);
  }
}

export function mergeDeep<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const output: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    if (isUnsafeKey(key) || value === undefined) {
      continue;
    }

    const current = output[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      output[key] = mergeDeep(current, value);
    } else {
      output[key] = value;
    }
  }

  return output as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isUnsafeKey(key: string): boolean {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}
