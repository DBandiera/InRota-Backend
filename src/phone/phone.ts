import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { AppError } from "../errors.js";

export function normalizeMobilePhone(rawPhone: string): string {
  const parsed = parsePhoneNumberFromString(rawPhone, "BR");
  if (!parsed?.isValid() || parsed.getType() !== "MOBILE") {
    throw new AppError(
      400,
      "INVALID_PHONE",
      "Informe um número de celular válido, com DDD."
    );
  }
  return parsed.number;
}
