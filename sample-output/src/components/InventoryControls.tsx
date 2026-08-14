import { FormControl, InputLabel, MenuItem, Select, Stack, TextField } from "@mui/material";

export type SortOption = "year" | "make";

interface InventoryControlsProps {
  search: string;
  sortBy: SortOption;
  onSearchChange: (value: string) => void;
  onSortChange: (value: SortOption) => void;
}

export default function InventoryControls({ search, sortBy, onSearchChange, onSortChange }: InventoryControlsProps) {
  return (
    <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mb: 3 }}>
      <TextField
        fullWidth
        label="Search by model"
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
        inputProps={{ "aria-label": "Search inventory by model" }}
      />
      <FormControl sx={{ minWidth: { sm: 180 } }}>
        <InputLabel id="inventory-sort-label">Sort by</InputLabel>
        <Select labelId="inventory-sort-label" value={sortBy} label="Sort by" onChange={(event) => onSortChange(event.target.value as SortOption)}>
          <MenuItem value="year">Year</MenuItem>
          <MenuItem value="make">Make</MenuItem>
        </Select>
      </FormControl>
    </Stack>
  );
}
