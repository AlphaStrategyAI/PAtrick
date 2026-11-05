import { DomainError, artifactSchema, reviewSchema, executionPlanSchema, digest, pathAllowed, type Task, type Project, type Artifact, type Review } from './domain.js';

export function testsRecorded(commands:readonly string[],tests:readonly {command:string;passed:boolean;output:string}[]):boolean {
 return commands.every(command=>tests.filter(test=>test.command===command).length===1&&tests.some(test=>test.command===command&&!!test.output.trim()));
}
export function assertPlanBinding(task:Task,project:Project):void {
 const plan=executionPlanSchema.parse(task.plan);
 if(plan.taskVersion!==task.version||plan.sourceRevision!==task.sourceRevision||[...plan.paths,...(plan.testFiles??[])].some(path=>!pathAllowed(path,project.allowedPaths))||new Set(plan.paths).size!==plan.paths.length||!plan.paths.includes(project.prdPath))throw new DomainError('The plan does not match the current task, source revision or allowed repository paths.','invalid_plan',403);
 if(new Set(plan.tests).size!==plan.tests.length||plan.tests.some(command=>!command.trim()))throw new DomainError('The plan must name unique executable validation commands.','invalid_plan');
}
export function assertArtifactBinding(task:Task,project:Project,value:unknown):Artifact {
 const artifact=artifactSchema.parse(value),plan=task.plan;
 if(!plan||artifact.taskVersion!==task.version||artifact.planHash!==digest(plan)||artifact.baselineSha!==plan.baselineSha||artifact.files.some(file=>!plan.paths.includes(file.path)||!pathAllowed(file.path,project.allowedPaths))||new Set(artifact.files.map(file=>file.path)).size!==artifact.files.length||!artifact.files.some(file=>file.path===project.prdPath))throw new DomainError('The artifact is not bound to the current plan and authorized paths.','invalid_artifact',403);
 if(!testsRecorded(plan.tests,artifact.tests))throw new DomainError('The artifact lacks actual results for the planned tests.','missing_test_evidence');
 return artifact;
}
export function assertReviewBinding(task:Task,value:unknown):Review {
 const review=reviewSchema.parse(value);
 if(!task.plan||!task.artifact||review.taskVersion!==task.version||review.planHash!==digest(task.plan)||review.artifactHash!==digest(task.artifact))throw new DomainError('The independent review does not match the current task, plan and actual artifact.','invalid_review');
 if(!testsRecorded(task.plan.tests,review.tests))throw new DomainError('The independent reviewer did not run all planned tests.','missing_test_evidence');
 return review;
}
