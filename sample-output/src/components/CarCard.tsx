import { Card, CardContent, CardMedia, Typography } from "@mui/material";
import type { Car } from "../types";

interface CarCardProps { car: Car }

export default function CarCard({ car }: CarCardProps) {
  return (
    <Card sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <picture>
        <source media="(max-width: 640px)" srcSet={car.mobile} />
        <source media="(max-width: 1023px)" srcSet={car.tablet} />
        <CardMedia component="img" height="190" image={car.desktop} alt={`${car.make} ${car.model}`} sx={{ objectFit: "cover" }} />
      </picture>
      <CardContent>
        <Typography variant="h6" component="h2">{car.make} {car.model}</Typography>
        <Typography color="text.secondary">Year: {car.year}</Typography>
        <Typography color="text.secondary">Color: {car.color}</Typography>
      </CardContent>
    </Card>
  );
}
