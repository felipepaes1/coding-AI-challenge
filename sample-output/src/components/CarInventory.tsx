import { useMemo, useState } from "react";
import { Alert, CircularProgress, Grid, Stack, Typography } from "@mui/material";
import { useCars } from "../hooks/useCars";
import CarCard from "./CarCard";
import InventoryControls, { type SortOption } from "./InventoryControls";
import AddCarForm from "./AddCarForm";

export default function CarInventory() {
  const { cars, loading, error, refetch } = useCars();
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("year");
  const visibleCars = useMemo(() => cars.filter((car) => car.model.toLowerCase().includes(search.trim().toLowerCase())).sort((a, b) => sortBy === "year" ? b.year - a.year : a.make.localeCompare(b.make)), [cars, search, sortBy]);

  return <Stack spacing={2}>
    <AddCarForm onAdded={refetch} />
    <InventoryControls search={search} sortBy={sortBy} onSearchChange={setSearch} onSortChange={setSortBy} />
    {loading && <Stack alignItems="center" py={4}><CircularProgress aria-label="Loading inventory" /></Stack>}
    {error && <Alert severity="error" action={<button onClick={() => void refetch()}>Retry</button>}>{error.message}</Alert>}
    {!loading && !error && visibleCars.length === 0 && <Typography color="text.secondary">No cars match your search.</Typography>}
    {!loading && !error && visibleCars.length > 0 && <Grid container spacing={3}>{visibleCars.map((car) => <Grid key={car.id} item xs={12} sm={6} md={4}><CarCard car={car} /></Grid>)}</Grid>}
  </Stack>;
}
