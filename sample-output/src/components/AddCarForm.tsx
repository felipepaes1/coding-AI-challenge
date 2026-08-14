import { useState, type FormEvent } from "react";
import { useMutation } from "@apollo/client";
import { Alert, Button, Card, CardContent, Stack, TextField, Typography } from "@mui/material";
import { ADD_CAR } from "../graphql/queries";

interface FormValues { make: string; model: string; year: string; color: string }
const initialValues: FormValues = { make: "", model: "", year: "", color: "" };
interface AddCarFormProps { onAdded: () => Promise<unknown> | void }

export default function AddCarForm({ onAdded }: AddCarFormProps) {
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState<Partial<Record<keyof FormValues, string>>>({});
  const [message, setMessage] = useState("");
  const [addCar, { loading }] = useMutation(ADD_CAR);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors: typeof errors = {};
    (Object.keys(values) as (keyof FormValues)[]).forEach((key) => { if (!values[key].trim()) nextErrors[key] = "This field is required"; });
    const year = Number(values.year);
    if (values.year.trim() && (!Number.isInteger(year) || year < 1886 || year > 2100)) nextErrors.year = "Enter a valid year";
    setErrors(nextErrors); setMessage("");
    if (Object.keys(nextErrors).length) return;
    try { await addCar({ variables: { make: values.make.trim(), model: values.model.trim(), year, color: values.color.trim() } }); await onAdded(); setValues(initialValues); setMessage("Car added to inventory."); }
    catch { setMessage("Unable to add car. Please try again."); }
  };
  return <Card component="section" aria-labelledby="add-car-heading"><CardContent><Stack component="form" onSubmit={submit} spacing={2}><Typography id="add-car-heading" variant="h6">Add a car</Typography><Stack direction={{ xs: "column", sm: "row" }} spacing={2}>{(["make", "model", "year", "color"] as const).map((key) => <TextField key={key} label={key[0]?.toUpperCase() + key.slice(1)} type={key === "year" ? "number" : "text"} value={values[key]} onChange={(e) => setValues({ ...values, [key]: e.target.value })} error={Boolean(errors[key])} helperText={errors[key]} required fullWidth inputProps={key === "year" ? { min: 1886, max: 2100 } : undefined} />)}</Stack><Button type="submit" variant="contained" disabled={loading}>{loading ? "Adding…" : "Add car"}</Button>{message && <Alert severity={message.startsWith("Car") ? "success" : "error"} role="status">{message}</Alert>}</Stack></CardContent></Card>;
}
